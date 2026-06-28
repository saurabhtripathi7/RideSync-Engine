# RideSync Engine

An event-driven, airport cab-pooling backend that matches passengers heading in similar directions into shared rides. Built to learn and demonstrate Redis, distributed locking, RabbitMQ async processing, and PostgreSQL transactions under concurrent load.

**Load test results (k6, 10 VUs, 864 requests):**
- `p(95) HTTP booking latency: 19.66ms`
- `p(90) end-to-end match latency: 528ms`
- `Error rate: 0.00%`

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture Overview](#2-architecture-overview)
3. [Tech Stack and Why Each Was Chosen](#3-tech-stack-and-why-each-was-chosen)
4. [Database Design](#4-database-design)
5. [Redis — What Lives There and Why](#5-redis--what-lives-there-and-why)
6. [The Pooling Algorithm](#6-the-pooling-algorithm)
7. [Fare Calculation](#7-fare-calculation)
8. [RabbitMQ Integration](#8-rabbitmq-integration)
9. [Distributed Locking](#9-distributed-locking)
10. [API Reference](#10-api-reference)
11. [Load Testing with k6](#11-load-testing-with-k6)
12. [Project Setup](#12-project-setup)
13. [Interview Q&A — Everything That Could Be Asked](#13-interview-qa--everything-that-could-be-asked)

---

## 1. What This System Does

All passengers originate from the same airport. They each have a dropoff destination somewhere in the city. The system tries to group passengers into shared cabs if their routes overlap — minimizing detour for everyone while reducing individual fares.

**Core flow:**
1. Passenger requests a ride with their dropoff coordinates and detour tolerance
2. System immediately responds with `SEARCHING` status (async, non-blocking)
3. A background worker picks up the request and runs the pooling algorithm
4. The algorithm either inserts the passenger into an existing forming pool or creates a new pool and assigns a driver
5. Passenger polls a status endpoint and eventually gets `MATCHED` with driver and fare details

**What "pooling" means concretely:** if Passenger A is going to Noida Sector 62 and Passenger B is going to Noida Sector 18 (nearby), they share the same cab. Passenger A's direct distance is 40km. With pooling, the cab drops B first, adding 5km to A's route — A's `currentRouteDist` = 45km. Since A accepted up to 30% detour, and 5/40 = 12.5%, A is eligible to be pooled with B. Both passengers pay less than a solo ride.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT                               │
│              (Postman / k6 / Mobile App)                    │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                   EXPRESS SERVER (port 3000)                 │
│                                                             │
│  POST /rides/request                                        │
│    1. prisma.ride.create()  ──────────────────► PostgreSQL  │
│    2. publishRideRequested()  ────────────────► RabbitMQ    │
│    3. res.status(202)  ◄── responds IMMEDIATELY             │
│                                                             │
│  GET /rides/:id/status  ──────────────────────► PostgreSQL  │
└─────────────────────────────────────────────────────────────┘
                                │
                         RabbitMQ Queue
                      (ride.requested)
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    WORKER PROCESS                           │
│                                                             │
│  channel.consume()                                          │
│    1. findEligibleDriver()  ──────────────────► Redis       │
│    2. acquirePoolLock()  ─────────────────────► Redis       │
│    3. processRide() / createNewPool()  ───────► PostgreSQL  │
│    4. channel.ack()                                         │
└─────────────────────────────────────────────────────────────┘

Infrastructure (Docker):
  ├── PostgreSQL:5432   — persistent data store
  ├── Redis:6379        — driver availability + pool locks
  └── RabbitMQ:5672     — async message queue
```

**Why two separate processes (server + worker)?**

If matching ran inside the HTTP handler, the passenger would wait 500ms+ for the algorithm to complete before getting a response. Separating them means the HTTP response is instant (19ms), and matching happens in the background. If the worker crashes mid-processing, RabbitMQ holds the unacked message and redelivers it on restart — no rides are lost.

---

## 3. Tech Stack and Why Each Was Chosen

| Technology | Role | Why |
|---|---|---|
| Node.js + TypeScript | Runtime + type safety | Async I/O fits event-driven architecture; TypeScript catches bugs at compile time |
| Express | HTTP server | Minimal, unopinionated, industry standard |
| PostgreSQL | Primary database | ACID transactions critical for fare updates and pool state changes |
| Prisma | ORM | Type-safe queries, migrations, readable schema |
| Redis | Cache + locks | Sub-millisecond reads for driver availability; atomic NX locks for concurrency |
| RabbitMQ | Message queue | Durable async processing; automatic retry on worker crash |
| amqplib | RabbitMQ Node.js driver | Official AMQP 0-9-1 client |
| k6 | Load testing | Scriptable, metrics-rich, industry standard for performance testing |
| Docker Compose | Infrastructure | Reproducible local environment |

---

## 4. Database Design

### Models and Relationships

```
Passenger ──< Ride >── Pool >── Driver ── Cab
                  └─────────────────────────┘
```

**Passenger** — a person who requests rides. Has many Rides.

**Cab** — a physical vehicle with seat and luggage capacity. One Driver per Cab.

**Driver** — linked to one Cab. Has a status (AVAILABLE/BUSY/OFFLINE). Has many Pools.

**Pool** — a shared cab trip. Has one Driver, one Cab, many Rides. Stores the entire route as JSON arrays.

**Ride** — one passenger's journey. Belongs to one Passenger and one Pool (once matched).

### Key Fields Explained

**`Pool.routeOrder`** — JSON array of ride IDs in drop sequence. e.g. `["rideA", "rideC", "rideB"]` means the cab drops A first, then C, then B.

**`Pool.routeDropoffLats` / `routeDropoffLngs`** — JSON arrays of coordinates matching routeOrder. Used by the insertion algorithm to compute distances between stops.

**`Pool.totalRouteDist`** — total km the cab drives on this trip. Used for fare calculation.

**`Ride.directDist`** — straight-line distance from airport to this passenger's dropoff. Calculated server-side using Haversine — never supplied by client.

**`Ride.currentRouteDist`** — actual distance the passenger travels in the pooled route. Always >= directDist. The difference is their detour.

**`Ride.maxDetourPct`** — passenger's tolerance for detour. If they set 30, they accept up to 30% longer route than direct.

**`Ride.dropOrder`** — position in the cab's drop sequence (1 = dropped first). Updated when new passengers are inserted ahead.

**`Ride.fare`** — calculated dynamically and updated if new passengers join the pool behind them.

### Why Coordinates Are Stored as JSON Arrays on Pool (Not Normalized)

The insertion algorithm needs all coordinates for a pool in one read — if stored normalized in a join table, every algorithm run would need N+1 queries for N stops. Denormalizing onto Pool means one query gets everything. The tradeoff: updating a stop requires rewriting the entire array. Acceptable because pool routes change infrequently.

### Database Indexes

```prisma
@@index([status, createdAt(sort: Asc)])   // Pool — find FORMING pools oldest-first
@@index([poolId])                         // Ride — all rides in a pool
@@index([status])                         // Ride — count SEARCHING rides for surge pricing
@@index([phone])                          // Driver/Passenger — lookup by phone
```

These indexes exist specifically for the hottest queries: finding forming pools, fetching rides in a pool, and counting active rides for demand multiplier.

---

## 5. Redis — What Lives There and Why

Redis holds two things: driver availability data and pool locks.

### Driver Data

**`available_drivers` (Redis Set)**
Contains IDs of all drivers currently available for assignment.
```
SMEMBERS available_drivers
→ ["uuid1", "uuid2", "uuid3", ...]
```
A Set is used because:
- `SADD` / `SREM` are O(1)
- `SMEMBERS` gives all IDs in one call
- No duplicates possible

**`driver:<id>` (Redis Hash)**
Stores each available driver's capacity details.
```
HGETALL driver:uuid1
→ { status: "AVAILABLE", seatsAvailable: "4", luggageCapacity: "4" }
```
A Hash is used because it maps field→value and `HGETALL` fetches all fields atomically.

**Why not query PostgreSQL for available drivers?**
Finding an eligible driver for every ride request would hit the DB under load. With Redis, `findEligibleDriver()` reads entirely from memory — microseconds vs milliseconds. The tradeoff: Redis and PostgreSQL can get out of sync if the app crashes mid-operation. This is acceptable for a pooling system — a driver appearing available when they're not just means the next lock attempt fails, and the algorithm tries another driver.

### Pool Locks

**`lock:pool:<poolId>` (Redis String with NX + EX)**
```
SET lock:pool:uuid "worker-123" EX 5 NX
```
- `NX` — only set if key does NOT exist (atomic)
- `EX 5` — auto-expire after 5 seconds (safety net if worker crashes)
- Value = worker ID (for debugging which worker holds the lock)

Full explanation in section 9.

---

## 6. The Pooling Algorithm

**File:** `src/services/pooling.service.ts`

### Entry Point: `processRide(rideId)`

```
1. Fetch ride from DB
2. If not SEARCHING, skip (already processed — guard against double delivery)
3. Try up to MAX_ATTEMPTS=3 times to insert into an existing pool
4. If all attempts fail → createNewPool()
```

### Step 1: Finding Candidate Pools — `getFormingPools()`

```typescript
const cutoff = new Date(Date.now() - POOL_WINDOW_SECONDS * 1000); // 90s ago

prisma.pool.findMany({
  where: { status: FORMING, createdAt: { gte: cutoff } },
  orderBy: { createdAt: "asc" },  // oldest first — they've waited longest
  take: MAX_POOLS_TO_CHECK,       // max 5 pools checked per ride
  include: { cab: true },
})
```

**Why 90-second window?** Pools stay FORMING for 90 seconds. Any ride request within that window can join. After 90s, the pool is implicitly closed — too much time has passed to keep adding passengers.

**Why oldest-first?** Fairness. Pools that have been waiting longest get filled first. Without ordering, newer pools might keep getting checked while older ones starve.

**Why MAX_POOLS_TO_CHECK=5?** Bounding the search keeps the algorithm O(p×k) where p=pools checked and k=stops per pool. With p≤5 and k≤4 in practice, this is ~80 distance calculations max — very fast.

### Step 2: Capacity Check

Before running the algorithm, quick rejection:
```typescript
if (pool.totalSeatsUsed + ride.seatsNeeded > pool.cab.totalSeats) continue;
if (pool.totalLuggageUsed + ride.luggageCount > pool.cab.luggageCapacity) continue;
```

No point running expensive geometry if the cab is already full.

### Step 3: Route Insertion Heuristic — `findBestInsertionIndex()`

This is the core algorithm. Given an existing route `[Airport → A → B → C]`, find the best position to insert new passenger D.

**Possible positions:** before A, between A and B, between B and C, after C.

**For each position i:**

1. Calculate `extraDist` — how much longer the total route becomes
   - Insert at end: `dist(prev → D)`
   - Insert in middle: `dist(prev → D) + dist(D → next) - dist(prev → next)`

2. Calculate `dRouteDist` — how far D actually travels (prefix distance to reach D's stop + last leg)

3. Check D's detour: `(dRouteDist - D.directDist) / D.directDist ≤ D.maxDetourPct/100`

4. Check every existing passenger after position i — their route gets longer by `extraDist`. Verify each stays within their own `maxDetourPct`.

5. Among all valid positions, pick the one with minimum `extraDist` (least disruption to total route).

**Example:**
```
Existing route: Airport → Noida Sector 62 (40km total)
New passenger: Noida Sector 18 (38km direct), maxDetourPct=30%

Try insert at position 0 (before Sector 62):
  extraDist = dist(Airport→Sector18) + dist(Sector18→Sector62) - dist(Airport→Sector62)
            = 38 + 3 - 40 = 1km

New passenger's route dist = 38km
Detour = (38-38)/38 = 0% ✓ within 30%

Existing passenger's new route dist = 40 + 1 = 41km
Detour = (41-40)/40 = 2.5% ✓ within their limit

Valid insertion. extraDist=1km → best position.
```

### Step 4: Commit Insertion — `commitInsertion()`

Runs inside a `prisma.$transaction()`:
1. Update Pool: new routeOrder, new coordinate arrays, new totalRouteDist, new seat/luggage counts
2. For every passenger after the insertion point: update their `currentRouteDist` (+extraDist), recalculate fare, increment `dropOrder`
3. Update the new ride: set poolId, status=MATCHED, dropOrder, fare, currentRouteDist

**Why a transaction?** If any of these updates fail, all must roll back. A partial update (pool updated but ride status not changed) would leave the system in an inconsistent state — a ride that thinks it's SEARCHING but a pool that includes it.

### Step 5: Lock Acquire Before Commit

Between finding the best pool and committing, another worker might be doing the same for a different ride. The Redis lock ensures only one worker modifies a pool at a time.

```typescript
const acquired = await acquirePoolLock(bestPoolId, workerId);
if (!acquired) continue; // try next attempt
```

After acquiring lock, re-fetch pool from DB (fresh data — another worker may have modified it between our initial check and lock acquisition). Re-run capacity and insertion checks on fresh data before committing.

### Step 6: Create New Pool — `createNewPool()`

Called when no existing pool can accommodate the ride.

1. `findEligibleDriver()` — scans Redis for a driver with sufficient seats and luggage capacity
2. `markDriverBusy()` — remove from `available_drivers` set, set hash status to BUSY
3. Create Pool record in DB with initial route = just this one passenger
4. Update Ride: status=MATCHED, dropOrder=1, fare calculated for solo passenger

---

## 7. Fare Calculation

**File:** `src/services/pricing.service.ts`

```
finalFare = (passengerSplit + luggageSurcharge + detourSurcharge) × demandMultiplier
```

**`passengerSplit`** = `(currentRouteDist × BASE_RATE_PER_KM) / passengersInPool`
- ₹12/km base rate
- Split equally among all passengers
- A solo passenger pays full base fare; if 3 people share, each pays 1/3

**`luggageSurcharge`** = `luggageCount × ₹20`
- Flat per-bag charge

**`detourSurcharge`** = `detourPct × 0.005 × baseFare`
- For every 1% detour the passenger accepted, fare increases 0.5%
- Discourages passengers from setting huge detour tolerance just to get into more pools
- A passenger who accepted 20% detour pays 10% more than fare calculated on direct distance

**`demandMultiplier`** (surge pricing):
```typescript
const multiplier = activeRides / availableDrivers;
return Math.min(multiplier, MAX_DEMAND_MULTIPLIER); // capped at 2x
```
- If 10 rides are searching and 10 drivers available → multiplier = 1.0 (no surge)
- If 20 rides searching and 5 drivers available → multiplier = 4.0 → capped to 2.0
- If 0 drivers available → returns MAX_DEMAND_MULTIPLIER (2.0) immediately

**Why fares are recalculated when a new passenger joins a pool:**
If passenger A was solo (fare ₹500), then B joins, A's fare recalculates to ₹250 (split by 2). This requires updating A's fare record in the same transaction as inserting B — hence the `$transaction` in `commitInsertion`.

---

## 8. RabbitMQ Integration

### Why RabbitMQ

Without a queue, `POST /rides/request` would call `processRide()` synchronously — the passenger waits 500ms+ for matching to complete. With RabbitMQ:
- HTTP response returns in 19ms (just DB write + publish)
- Matching runs async in a separate process
- If the worker crashes mid-matching, the unacked message is redelivered automatically

### The Four Files

**`queue.connection.ts`** — owns the single TCP connection and channel per process. Both server and worker call `connectQueue()` independently on startup, getting their own connections. Exports `getChannel()` — all other files use this instead of managing their own connections.

**`ride.publisher.ts`** — called by the controller after creating a ride in DB. Uses `channel.sendToQueue()` with `persistent: true` so messages survive a RabbitMQ restart.

**`ride.worker.ts`** — registers a consumer with `channel.consume()`. Calls `prefetch(1)` so only one message is delivered at a time. After processing, calls `channel.ack()` to tell RabbitMQ the message is done. On error, calls `channel.nack(msg, false, true)` to requeue.

**`worker.ts`** — process entry point. Calls `connectQueue()` then `startRideWorker()`. Run as a separate Node process from the server.

### Key Terms

**Connection** — one TCP socket to RabbitMQ. Expensive. One per process.

**Channel** — virtual lightweight connection inside one TCP connection. All pub/sub happens on a channel.

**durable: true** (on queue) — queue definition survives RabbitMQ restart.

**persistent: true** (on message) — message body is written to disk, survives RabbitMQ restart.

**prefetch(1)** — without this, RabbitMQ sends all queued messages to the worker at once. With it, the worker gets exactly one message at a time, and the next is only sent after `ack()`.

**ack** — "I processed this successfully, delete it from queue."

**nack(msg, false, true)** — "I failed, put it back in the queue for retry."

### Message Serialization

JavaScript objects can't be sent over AMQP — only bytes. The pipeline:
```
Publisher:  { rideId: "abc" } → JSON.stringify() → '{"rideId":"abc"}' → Buffer.from() → bytes
Worker:     bytes → msg.content.toString() → '{"rideId":"abc"}' → JSON.parse() → { rideId: "abc" }
```

### The Two Queues

`ride.requested` — published when passenger books. Consumed by `startRideWorker()` which runs `processRide()`.

`ride.cancelled` — published when passenger cancels. Consumer (`startCancellationWorker`) not yet implemented — would remove the ride from its pool, recalculate remaining passengers' routes and fares, and potentially free the driver if pool is empty.

---

## 9. Distributed Locking

### The Problem Without Locks

Two ride requests arrive simultaneously. Both workers find Pool X has space. Both run the insertion algorithm. Both decide to insert their ride at position 2. Both call `commitInsertion()`. Result: race condition — the pool's routeOrder gets corrupted, seat counts are wrong, two rides think they're both at dropOrder=2.

### The Solution

Before modifying a pool, a worker must acquire its lock:
```typescript
const result = await redis.set(`lock:pool:${poolId}`, workerId, "EX", 5, "NX");
```

`NX` (Not eXists) makes this atomic — Redis only sets the key if it doesn't already exist. This is a single atomic operation, not a check-then-set. Both workers cannot succeed simultaneously.

- Worker A calls SET NX → key doesn't exist → set succeeds → returns "OK" → acquired = true
- Worker B calls SET NX → key exists → set fails → returns null → acquired = false → Worker B tries next attempt

`EX 5` — the lock auto-expires after 5 seconds. Safety net: if Worker A crashes after acquiring the lock but before releasing it, the lock doesn't stay forever. After 5 seconds, other workers can acquire it.

### Double-Check After Lock

After acquiring the lock, the worker re-fetches pool data from DB:
```typescript
const freshPool = await prisma.pool.findUnique({ where: { id: bestPoolId }, include: { cab: true } });
```

Why? Between the initial capacity check and lock acquisition, another worker may have already modified the pool (added a passenger, used up seats). The fresh read ensures we're working with current data before committing.

### Lock Release

```typescript
} finally {
  await releasePoolLock(bestPoolId); // always runs, even if commitInsertion throws
}
```

`finally` guarantees the lock is released regardless of success or failure. If release fails (Redis down), the EX 5 expiry handles it automatically.

---

## 10. API Reference

### `POST /rides/request`
Book a ride. Returns immediately with `SEARCHING` status.

**Body:**
```json
{
  "passengerId": "uuid",
  "dropoffLat": 28.5355,
  "dropoffLng": 77.3910,
  "seatsNeeded": 1,
  "luggageCount": 1,
  "maxDetourPct": 30
}
```

**Response 202:**
```json
{ "rideId": "uuid", "status": "SEARCHING" }
```

**Note:** `maxDetourPct` is a percentage integer — 30 means the passenger accepts up to 30% longer route than direct. Do not pass 0.3.

**Note:** `directDist` is NOT accepted from the client — calculated server-side using Haversine from airport coordinates to dropoff. This prevents clients from supplying incorrect distances that would corrupt fare calculations.

### `GET /rides/:id/status`
Poll for matching result.

**Response when SEARCHING:**
```json
{ "rideId": "uuid", "status": "SEARCHING" }
```

**Response when MATCHED:**
```json
{
  "rideId": "uuid",
  "status": "MATCHED",
  "dropOrder": 1,
  "fare": 1078.33,
  "poolSize": 2,
  "driver": {
    "name": "Rajan Kumar",
    "phone": "9910001001",
    "cab": { "plate": "DL01AB1001", "type": "SEDAN" }
  }
}
```

### Other Endpoints (CRUD, for testing/admin)

```
GET    /passengers          list all passengers
POST   /passengers          create passenger
GET    /drivers             list all drivers
POST   /drivers             create driver
GET    /cabs                list all cabs
POST   /cabs                create cab
GET    /rides               list all rides
GET    /rides/:id           full ride object with pool and passenger
```

---

## 11. Load Testing with k6

### What k6 Is

k6 is a load testing tool. You write a script describing what one user does, k6 runs it with N virtual users (VUs) simultaneously and measures performance.

### Test Type: Ramping VU Test

```
VUs
10 |          ___________
   |         /           \
   |        /             \
 0 |_______/               \____
   0s     15s              45s  55s
```

- 0→15s: ramp up to 10 VUs (simulate growing traffic)
- 15→45s: hold at 10 VUs (sustained load)
- 45→55s: ramp down

### What One VU Does Per Iteration

```
1. Pick random passengerId from seeded list
2. Pick random dropoff coordinates
3. POST /rides/request → assert 202 + rideId present
4. Poll GET /rides/:id/status every 500ms for up to 10s
5. If MATCHED → record match_latency = (now - bookStart)
6. If timeout → count as unmatched
7. Sleep 1s
8. Repeat
```

### Metrics Explained

**`http_req_duration`** — time from HTTP request sent to response received. Your p(95)=19.66ms means 95% of all HTTP requests (both booking and polling) completed within 19.66ms. Fast because the booking endpoint responds immediately without waiting for matching.

**`match_latency_ms`** (custom Trend) — time from ride creation to MATCHED status. Measures the full async pipeline: queue delivery + worker processing + DB writes. Your p(90)=528ms.

**`http_req_failed`** — percentage of non-2xx responses. 0.00% means every single request succeeded.

**`matched_rides` / `unmatched_rides`** (custom Counters) — 33 matched, 38 unmatched. Unmatched is expected: once all 12 drivers are assigned to pools and marked BUSY, new rides have no drivers to assign and stay SEARCHING. In a real system, drivers complete trips and return to AVAILABLE.

### Thresholds (Pass/Fail Criteria)

```javascript
thresholds: {
  http_req_duration: ["p(95)<500"],   // ✓ got 19.66ms
  match_latency_ms:  ["p(90)<5000"],  // ✓ got 528ms
  http_req_failed:   ["rate<0.01"],   // ✓ got 0.00%
}
```

Thresholds cause k6 to exit with error code 1 if violated — useful for CI/CD gates.

### What the 19ms vs 528ms Gap Proves

The 19ms is the HTTP response time — fast because RabbitMQ decouples the response from the work.
The 528ms is the actual matching time — the full pipeline including Redis lock, DB reads, algorithm, DB transaction.
Without RabbitMQ, every booking request would take 528ms to respond. With it, passengers get an immediate 202 and poll for the result.

### Running the Test

```bash
# Reset state before each run
docker exec -it airport-redis redis-cli FLUSHALL
npm run drivers:onduty

# Run in separate terminal
npm run dev

# Run load test
k6 run load-test.js
```

---

## 12. Project Setup

### Prerequisites

- Node.js 18+
- Docker Desktop
- k6 (`choco install k6` on Windows, `brew install k6` on Mac)

### Environment Variables

Create `.env`:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/airport_pooling"
REDIS_URL="redis://localhost:6379"
RABBITMQ_URL="amqp://localhost:5672"
```

### First-Time Setup

```bash
# 1. Install dependencies
npm install

# 2. Start infrastructure
docker compose up -d

# 3. Run DB migrations
npx prisma migrate dev --name init

# 4. Generate Prisma client
npx prisma generate

# 5. Seed database (passengers, cabs, drivers)
npm run db:seed

# 6. Put drivers on duty (seed Redis)
npm run drivers:onduty

# 7. Verify Redis has drivers with hashes
docker exec -it airport-redis redis-cli SMEMBERS available_drivers
docker exec -it airport-redis redis-cli HGETALL driver:<any-uuid>
# Should show: status AVAILABLE, seatsAvailable X, luggageCapacity X
```

### Running

```bash
# Start both server and worker together
npm run dev

# Or separately
npm run dev:server   # Express API on port 3000
npm run dev:worker   # RabbitMQ consumer
```

### Monitoring

- RabbitMQ Management UI: `http://localhost:15672` (guest/guest) → Queues tab shows message rates, ready/unacked counts
- Prisma Studio: `npx prisma studio` → browse all DB tables

### npm Scripts

```
npm run dev              start server + worker concurrently
npm run dev:server       server only
npm run dev:worker       worker only
npm run db:seed          create test passengers, cabs, drivers in PostgreSQL
npm run drivers:onduty   populate Redis with driver availability data
npm run db:migrate       run pending Prisma migrations
npm run db:studio        open Prisma Studio GUI
```

---

## 13. Interview Q&A — Everything That Could Be Asked

### Architecture

**Q: Why did you separate the server and worker into two processes?**
A: The matching algorithm takes ~500ms (Redis lock, DB reads, geometry calculations, DB transaction). If I ran it synchronously inside the HTTP handler, every passenger would wait 500ms for a response. Separating them means the HTTP response is instant — the server just writes to DB and publishes an event. The worker handles matching independently. Also, if the worker crashes, the unacked message in RabbitMQ is automatically redelivered — no rides are lost. With synchronous processing, a crash would silently drop the ride.

**Q: Why RabbitMQ specifically, not just setTimeout or a BullMQ job queue?**
A: RabbitMQ is a dedicated message broker with durability guarantees. Messages with `persistent: true` are written to disk — they survive a RabbitMQ restart. BullMQ uses Redis as its backend, which is also fine, but RabbitMQ's AMQP protocol is the industry standard for service-to-service async messaging. I used RabbitMQ to learn the protocol itself, not just a higher-level abstraction.

**Q: What happens if the worker crashes while processing a ride?**
A: The message stays unacked in RabbitMQ. When the worker restarts and calls `channel.consume()`, RabbitMQ redelivers all unacked messages. The worker has a guard at the top: `if (ride.status !== RideStatus.SEARCHING) { channel.ack(msg); return; }` — so if a ride was partially processed and is already MATCHED, the redelivered message is safely skipped.

**Q: What happens if RabbitMQ itself crashes?**
A: The queue is declared with `durable: true` and messages are sent with `persistent: true`. Both together mean the queue definition and messages are written to disk. When RabbitMQ restarts, they're recovered. If RabbitMQ crashes before the server publishes (the DB write succeeded but publish failed), that ride stays SEARCHING forever — this is a known gap that a production system would address with the Outbox pattern (write event to DB in same transaction, separate process publishes from DB to queue).

### Redis

**Q: Why use Redis for driver availability instead of querying PostgreSQL?**
A: Under load, every ride request needs to find an available driver. Querying PostgreSQL with a `WHERE status = 'AVAILABLE'` would add a DB read per ride request. Redis reads are in-memory at microsecond latency. The tradeoff is consistency — Redis and PostgreSQL can drift if the app crashes between marking a driver busy in Redis and updating their status in PostgreSQL. This is acceptable because the lock mechanism already handles race conditions, and a driver appearing available in Redis when they're not just causes one failed lock attempt.

**Q: Why a Redis Set for available_drivers instead of a List or Sorted Set?**
A: A Set gives O(1) `SADD`/`SREM` and guaranteed uniqueness — a driver can never appear twice. A List would require scanning for removal (O(n)). A Sorted Set would add unnecessary complexity. The only operation needed are: add driver, remove driver, get all available drivers. Set is the right data structure.

**Q: Why store driver capacity in a Hash instead of just the Set?**
A: The Set stores which drivers are available. The Hash stores HOW available they are — seats and luggage capacity. `findEligibleDriver()` needs to match a ride's `seatsNeeded` and `luggageCount` against each driver. Storing capacity in the Hash means one `HGETALL` per driver instead of a PostgreSQL join.

### Distributed Locking

**Q: Explain exactly how the Redis lock prevents race conditions.**
A: `SET lock:pool:uuid workerID EX 5 NX` is a single atomic operation. Redis executes it as one command — there's no gap between checking if the key exists and setting it. Two workers calling this simultaneously: Redis processes them sequentially (single-threaded command execution). The first gets "OK", the second gets null. Only the first proceeds to modify the pool. The second retries with the next best pool or a new attempt.

**Q: Why EX 5 on the lock?**
A: If a worker acquires the lock and then crashes before releasing it (before the `finally` block runs), the lock would stay forever and no other worker could modify that pool. The 5-second TTL means the lock auto-expires, and other workers can acquire it after 5 seconds. 5 seconds is chosen to be longer than any realistic `commitInsertion()` execution time.

**Q: What if two workers try to insert into the same pool and both succeed (lock not working)?**
A: The `prisma.$transaction()` inside `commitInsertion` provides a second layer. PostgreSQL transactions with the default READ COMMITTED isolation level prevent dirty reads. However, for the seat count check specifically, this alone isn't enough — you'd need `SELECT FOR UPDATE` to lock the row. The Redis lock is the primary guard and makes the PostgreSQL transaction's isolation level less critical here.

### Database

**Q: Why use a transaction in commitInsertion?**
A: `commitInsertion` does multiple writes: update Pool (route, seats, luggage), update N existing rides (their routeDist, fare, dropOrder), and update the new ride (poolId, status, fare). If any of these fail halfway through, the data would be in an inconsistent state — for example, the pool thinks it has 3 seats used but only 2 rides are linked to it. The transaction ensures all-or-nothing: either everything commits or everything rolls back.

**Q: Why store routeDropoffLats and routeDropoffLngs as JSON strings instead of an array column?**
A: PostgreSQL does support array columns, but Prisma's support for array operations in the version used here is limited. JSON strings are universally supported and the read/write patterns here are always the full array — never partial updates. The minor inefficiency of `JSON.parse()`/`JSON.stringify()` is acceptable.

**Q: What's the N+1 query problem and does your code have it?**
A: N+1 is when you fetch N records and then issue N additional queries to fetch related data for each. For example, fetching 5 pools and then querying rides for each pool separately = 1 + 5 = 6 queries. In `getFormingPools()`, the `include: { cab: true }` on the Prisma query does a JOIN — one query fetches pools and their cabs together. In `getPooledRides()`, a single query fetches all rides for one pool. No N+1 issues in the hot path.

### Algorithm

**Q: Why is the insertion heuristic O(p×k²) and is that acceptable?**
A: For each of the p pools checked (max 5), for each of the k+1 insertion positions, we compute extraDist (O(1)) and then check all existing passengers after the insertion point (O(k)). Total: O(p × k × k) = O(p×k²). With p=5 and k=4 (max practical pool size for a sedan/SUV), this is 5×16=80 operations. Completely acceptable — runs in microseconds.

**Q: Why do fares for existing passengers change when a new passenger joins?**
A: The fare formula splits the base cost by `passengersInPool`. If passenger A is solo and pays ₹500, and B joins making it a 2-person pool, each now pays ₹250 base. Additionally, passengers after the insertion point have their `currentRouteDist` increased by `extraDist` (the cab takes a longer route to accommodate the new stop). Both effects require recalculating and updating fares for affected passengers in the same transaction.

**Q: What's maxDetourPct and how is it enforced?**
A: It's the maximum percentage longer than the direct route a passenger is willing to travel. If direct distance is 40km and maxDetourPct=30, the passenger accepts up to 52km route (40×1.30). The algorithm checks this for the new passenger being inserted AND for every existing passenger after the insertion point (because inserting before them increases their route). Any violation rejects that insertion position.

### Load Testing

**Q: What does p(95) mean?**
A: 95th percentile. Sort all latency measurements from fastest to slowest. p(95) is the value at the 95% position. It means 95% of requests were faster than this value. It's more meaningful than average because averages are skewed by outliers — one 10-second request can drag the average up significantly while p(95) still accurately represents what most users experience.

**Q: Why were 38 rides unmatched in your load test?**
A: Expected behavior. The test runs for 55 seconds. Drivers are marked BUSY when assigned to a pool and never freed during the test (no trip completion flow). Once all 12 drivers are busy, `createNewPool()` calls `findEligibleDriver()` which returns null, and the function returns early without matching. The ride stays SEARCHING. Polling times out after 10 seconds and the VU counts it as unmatched. This correctly demonstrates that the system refuses to assign a non-existent driver rather than corrupting state.

**Q: Why is the HTTP booking latency (19ms) so much lower than the match latency (528ms)?**
A: This is exactly what RabbitMQ is for. The HTTP handler does two things: write to PostgreSQL and publish to RabbitMQ. Both are fast I/O operations — 19ms total. The 528ms is the full matching pipeline: message delivery to worker, Redis lock acquisition, PostgreSQL reads (forming pools + pooled rides), geometry calculations, PostgreSQL transaction (pool update + ride updates). The passenger doesn't wait for any of that — they get 202 immediately and poll separately.

---

## Appendix: File Structure

```
├── prisma/
│   ├── schema.prisma          database models and enums
│   └── seed.ts                test data: 10 passengers, 10 cabs, 10 drivers
├── scripts/
│   └── put-drivers-on-duty.ts populate Redis driver availability data
├── src/
│   ├── app.ts                 Express app setup, route mounting
│   ├── server.ts              HTTP server entry point, RabbitMQ connect
│   ├── worker.ts              Worker process entry point
│   ├── config/
│   │   └── constants.ts       airport coords, pricing rates, pool window
│   ├── db/
│   │   └── prisma.ts          Prisma client singleton
│   ├── cache/
│   │   ├── redis.client.ts    ioredis client singleton
│   │   ├── driver.cache.ts    driver availability CRUD on Redis
│   │   └── pool.cache.ts      pool lock acquire/release
│   ├── queues/
│   │   ├── queue.connection.ts  AMQP connection + channel + assertQueue
│   │   └── ride.publisher.ts    sendToQueue for ride events
│   ├── workers/
│   │   └── ride.worker.ts      consume ride.requested, call processRide
│   ├── services/
│   │   ├── pooling.service.ts  core algorithm: processRide, insertion heuristic
│   │   ├── pricing.service.ts  fare calculation with surge multiplier
│   │   ├── haversine.ts        great-circle distance formula
│   │   ├── ride.service.ts     ride CRUD + getRideStatus
│   │   ├── driver.service.ts   driver CRUD
│   │   ├── passenger.service.ts passenger CRUD
│   │   └── cab.service.ts      cab CRUD
│   ├── controllers/           request handlers, input validation
│   └── routes/                Express router definitions
├── load-test.js               k6 load test script
└── docker-compose.yml         PostgreSQL + Redis + RabbitMQ
```
