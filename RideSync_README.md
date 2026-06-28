# RideSync Engine 🚗

> **Event-driven ride-pooling backend** — matches passengers heading in the same direction, pools them into shared rides, and processes bookings asynchronously via a RabbitMQ producer-worker pipeline with Redis-based distributed locking and k6-validated performance.

---

## Table of Contents

1. [What This Project Does](#1-what-this-project-does)
2. [Tech Stack](#2-tech-stack)
3. [System Architecture](#3-system-architecture)
4. [Core Design Decisions (with rationale)](#4-core-design-decisions-with-rationale)
5. [Data Models](#5-data-models)
6. [API Endpoints](#6-api-endpoints)
7. [Booking Flow — Step by Step](#7-booking-flow--step-by-step)
8. [RabbitMQ Integration — Deep Dive](#8-rabbitmq-integration--deep-dive)
9. [Redis Distributed Locking — Deep Dive](#9-redis-distributed-locking--deep-dive)
10. [k6 Load Testing — Results & What They Mean](#10-k6-load-testing--results--what-they-mean)
11. [PostgreSQL Schema & Prisma](#11-postgresql-schema--prisma)
12. [Error Handling & Edge Cases](#12-error-handling--edge-cases)
13. [Interview Q&A — Every Tricky Question](#13-interview-qa--every-tricky-question)

---

## 1. What This Project Does

RideSync is a **ride-pooling coordination engine**. Think Ola Share / Uber Pool — multiple passengers travelling in the same direction share one cab, splitting the cost.

### Core capabilities:
- Passenger posts a ride request with pickup, drop, and time
- System matches them with an existing pool going the same route, or creates a new one
- Booking is queued via RabbitMQ and processed by a background worker
- Redis distributed lock prevents two simultaneous bookings from double-filling a pool
- PostgreSQL stores rides, pools, passengers, and booking state
- All of this is load-tested with k6 to validate production-readiness

### What it does NOT do (intentional scope):
- No real-time GPS tracking (out of scope for backend engine)
- No payment processing
- No driver-side logic (driver assignment is a separate concern)
- No cancellation worker yet (architecture is designed for it — see Section 8)

---

## 2. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js (Express) | Non-blocking I/O, perfect for async queue-based systems |
| Database | PostgreSQL | ACID transactions, strong consistency for booking state |
| ORM | Prisma | Type-safe queries, clean migration workflow |
| Message Queue | RabbitMQ | Durable async processing, decouples booking request from booking execution |
| Distributed Lock | Redis (`SET NX PX`) | Prevents race conditions on pool seat allocation |
| Load Testing | k6 | Scripted, CI-friendly, real latency percentile reporting |

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        CLIENT / API                          │
│                    POST /api/bookings                        │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     EXPRESS API LAYER                        │
│   - Validates request                                        │
│   - Finds or creates a matching RidePool                     │
│   - Publishes booking job to RabbitMQ queue                  │
│   - Returns 202 Accepted immediately                         │
└──────────┬───────────────────────────────────────────────────┘
           │  publishes to
           ▼
┌──────────────────────┐
│     RabbitMQ         │
│  Queue: bookings_q   │
│  Exchange: direct    │
│  Durable: true       │
└──────────┬───────────┘
           │  consumed by
           ▼
┌──────────────────────────────────────────────────────────────┐
│                  BOOKING WORKER (Consumer)                   │
│                                                              │
│  1. Acquire Redis lock on pool_id                            │
│  2. Re-validate seat availability (double-check in DB)       │
│  3. Create Booking record in PostgreSQL                       │
│  4. Decrement available_seats on RidePool                    │
│  5. Release Redis lock                                       │
│  6. ACK the RabbitMQ message                                 │
└──────────────────────────────────────────────────────────────┘
           │  reads/writes
           ▼
┌──────────────────────┐     ┌──────────────────────┐
│     PostgreSQL        │     │        Redis          │
│  - rides              │     │  - pool:{id}:lock     │
│  - ride_pools         │     │  (TTL: 10s)           │
│  - bookings           │     └──────────────────────┘
│  - passengers         │
└──────────────────────┘
```

### Why this architecture?

The API layer and the booking execution are **deliberately separated**. Here's why:

- If the booking logic ran synchronously in the request handler, a slow DB write would block the HTTP response.
- With RabbitMQ in between, the API responds instantly with `202 Accepted`. The worker processes in the background.
- This also gives you natural **backpressure** — if the worker falls behind, messages queue up instead of overwhelming the DB.
- RabbitMQ's durability (`durable: true`, `persistent: true`) means if the worker crashes, no booking is lost.

---

## 4. Core Design Decisions (with rationale)

### Decision 1: Why RabbitMQ over BullMQ/Redis queues?

BullMQ uses Redis as a queue. RabbitMQ is a dedicated message broker. Key differences:

| | RabbitMQ | BullMQ (Redis) |
|---|---|---|
| Durability | Messages persist to disk | Redis AOF/RDB (slower) |
| Protocol | AMQP (broker-level guarantees) | Custom on top of Redis |
| Acknowledgement | Native ACK/NACK/requeue | Manual implementation |
| Overhead | Separate process | Reuses Redis you already have |

For RideSync: RabbitMQ was chosen because booking integrity is critical. A lost booking message = a passenger with a confirmed ticket but no seat. AMQP's native ACK guarantees the message is only removed from the queue after the worker confirms successful DB write.

**In interviews:** "I chose RabbitMQ over BullMQ because booking messages needed broker-level durability guarantees. With BullMQ, you're building reliability on top of Redis which is primarily a cache. RabbitMQ's AMQP protocol gives you native ACK/NACK semantics — a message is only dequeued after the worker explicitly acknowledges successful processing."

### Decision 2: Why Redis for the distributed lock instead of PostgreSQL `SELECT FOR UPDATE`?

`SELECT FOR UPDATE` would work, but:
- It holds a DB transaction open for the entire lock duration
- Under high concurrency, this creates lock contention at the DB level
- Redis `SET NX PX` is an O(1) atomic operation, no transaction needed
- Lock TTL (10s) auto-releases if worker crashes — no deadlock

**The tradeoff:** Redis is not strongly consistent with PostgreSQL. So the worker does a **double-check**: acquire Redis lock → re-read seats from DB → then write. This two-step is important to explain in interviews.

### Decision 3: Why 202 Accepted instead of 200 OK?

HTTP 202 means "request accepted for processing, but processing is not complete." This is semantically correct for async systems. Returning 200 would imply the booking is done. Returning 202 + a `booking_id` lets the client poll `/api/bookings/:id` for status.

### Decision 4: Pool matching logic

When a new booking request comes in, the API tries to find an existing `RidePool` where:
1. Route overlaps (pickup area + drop area match)
2. `available_seats > 0`
3. Departure time is within the passenger's acceptable window
4. Pool status is `OPEN`

If no match → create a new `RidePool` with a fresh seat count (default: 3).

This matching happens **in the API layer, before queueing**. The worker doesn't re-match — it just executes the booking on the already-identified pool. This is an important separation of concerns.

---

## 5. Data Models

### `Passenger`
```prisma
model Passenger {
  id        String    @id @default(uuid())
  name      String
  phone     String    @unique
  email     String    @unique
  bookings  Booking[]
  createdAt DateTime  @default(now())
}
```

### `RidePool`
```prisma
model RidePool {
  id              String    @id @default(uuid())
  pickup_area     String
  drop_area       String
  departure_time  DateTime
  total_seats     Int       @default(3)
  available_seats Int       @default(3)
  status          PoolStatus @default(OPEN)
  bookings        Booking[]
  createdAt       DateTime  @default(now())
}

enum PoolStatus {
  OPEN      // accepting passengers
  FULL      // no seats left
  DEPARTED  // ride has started
  CANCELLED // cancelled
}
```

### `Booking`
```prisma
model Booking {
  id           String        @id @default(uuid())
  passengerId  String
  passenger    Passenger     @relation(fields: [passengerId], references: [id])
  ridePoolId   String
  ridePool     RidePool      @relation(fields: [ridePoolId], references: [id])
  status       BookingStatus @default(PENDING)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
}

enum BookingStatus {
  PENDING    // in RabbitMQ queue, not yet processed
  CONFIRMED  // worker successfully allocated seat
  FAILED     // worker couldn't allocate (pool full, etc.)
}
```

### Why `PENDING` status exists

When the API publishes to RabbitMQ, it first creates a `Booking` record with `status: PENDING`. This gives the client something to poll. The worker then updates it to `CONFIRMED` or `FAILED`. This is the **outbox pattern** lite — the booking record is the source of truth for what was requested.

---

## 6. API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/passengers` | Register a new passenger |
| GET | `/api/passengers/:id` | Get passenger details |
| POST | `/api/pools` | Manually create a ride pool |
| GET | `/api/pools` | List open pools (with filters) |
| GET | `/api/pools/:id` | Get pool details + current passengers |
| POST | `/api/bookings` | Request a booking (async — publishes to queue) |
| GET | `/api/bookings/:id` | Poll booking status |
| GET | `/api/bookings/passenger/:passengerId` | All bookings for a passenger |

### `POST /api/bookings` — Request body
```json
{
  "passengerId": "uuid",
  "pickup_area": "Gomti Nagar",
  "drop_area": "Hazratganj",
  "requested_time": "2026-06-30T09:00:00Z"
}
```

### `POST /api/bookings` — Response (202 Accepted)
```json
{
  "message": "Booking request accepted",
  "bookingId": "uuid",
  "status": "PENDING",
  "poolId": "uuid"
}
```

---

## 7. Booking Flow — Step by Step

Here's exactly what happens when `POST /api/bookings` is called:

```
Step 1: Validate request body
        - passengerId exists in DB?
        - pickup_area and drop_area are non-empty strings?
        - requested_time is a valid future datetime?

Step 2: Pool matching (in API controller)
        - Query: RidePool WHERE pickup_area = X AND drop_area = Y
                         AND available_seats > 0
                         AND status = OPEN
                         AND departure_time BETWEEN (requested_time - 30min)
                                                AND (requested_time + 30min)
        - If found → use this pool
        - If not found → CREATE new RidePool (available_seats: 3, status: OPEN)

Step 3: Create Booking record with status: PENDING
        - This is the optimistic write — we record the intent before processing

Step 4: Publish to RabbitMQ
        - Exchange: '' (default direct)
        - Queue: 'bookings_q'
        - Message: { bookingId, passengerId, poolId }
        - deliveryMode: 2 (persistent — survives broker restart)

Step 5: Return 202 Accepted with { bookingId, poolId, status: "PENDING" }

--- (async, in worker process) ---

Step 6: Worker receives message from bookings_q

Step 7: Acquire Redis lock
        - Key: pool:{poolId}:lock
        - SET pool:{poolId}:lock "1" NX PX 10000
        - If lock not acquired → requeue message (NACK with requeue: true)
          and retry after 100ms

Step 8: Re-read available_seats from PostgreSQL
        - Even though we checked in Step 2, another worker may have
          allocated a seat between Step 2 and Step 7
        - If available_seats === 0 → update Booking to FAILED, release lock, ACK

Step 9: Prisma transaction
        BEGIN;
          UPDATE RidePool SET available_seats = available_seats - 1
                          WHERE id = poolId AND available_seats > 0;
          UPDATE Booking SET status = 'CONFIRMED' WHERE id = bookingId;
          -- if available_seats becomes 0, also set pool status = FULL
        COMMIT;

Step 10: Release Redis lock
         DEL pool:{poolId}:lock

Step 11: ACK the RabbitMQ message
         - Only now is the message removed from the queue
         - If worker crashes before this, RabbitMQ redelivers to another worker
```

**Why the transaction in Step 9?**

Both the seat decrement and the booking confirmation must succeed or fail together. If the `UPDATE RidePool` succeeds but `UPDATE Booking` fails, we'd have a ghost allocation — a seat is taken but no booking record shows it. The Prisma `$transaction` wraps both in a single atomic operation.

---

## 8. RabbitMQ Integration — Deep Dive

### Connection setup
```javascript
const connection = await amqplib.connect(process.env.RABBITMQ_URL); // amqp://localhost
const channel = await connection.createChannel();

await channel.assertQueue('bookings_q', {
  durable: true  // queue survives RabbitMQ restart
});

channel.prefetch(1); // worker handles one message at a time
```

### `prefetch(1)` — why it matters

Without `prefetch(1)`, RabbitMQ pushes ALL queued messages to the worker at once. If you have 500 queued bookings and one worker, all 500 get loaded into memory. With `prefetch(1)`, the worker gets one message, processes it, ACKs it, then gets the next. This is critical for backpressure.

### Producer (API side)
```javascript
channel.sendToQueue(
  'bookings_q',
  Buffer.from(JSON.stringify({ bookingId, passengerId, poolId })),
  { persistent: true }  // message survives broker restart
);
```

### Consumer (Worker side)
```javascript
channel.consume('bookings_q', async (msg) => {
  if (!msg) return;

  const { bookingId, passengerId, poolId } = JSON.parse(msg.content.toString());

  try {
    const lockAcquired = await acquireRedisLock(poolId);
    if (!lockAcquired) {
      channel.nack(msg, false, true); // requeue
      return;
    }

    // ... process booking ...

    await releaseRedisLock(poolId);
    channel.ack(msg);  // remove from queue

  } catch (err) {
    await releaseRedisLock(poolId);
    channel.nack(msg, false, false); // don't requeue — send to DLQ if configured
  }
}, { noAck: false }); // manual acknowledgement
```

### ACK vs NACK — interview must-know

| | Meaning | Effect |
|---|---|---|
| `channel.ack(msg)` | "I processed this successfully" | Message deleted from queue |
| `channel.nack(msg, false, true)` | "I couldn't process this, try again" | Message requeued |
| `channel.nack(msg, false, false)` | "This message is bad, discard/DLQ" | Message goes to Dead Letter Queue |

### What is a Dead Letter Queue (DLQ)?

If a message is NACKed with `requeue: false`, RabbitMQ routes it to a DLQ (if configured). This is your safety net for messages that consistently fail — you can inspect them, fix the bug, and republish. In RideSync, the DLQ is the extension point for observability.

---

## 9. Redis Distributed Locking — Deep Dive

### The problem it solves

Imagine two concurrent booking requests for the same pool that has 1 seat left:

```
Worker A: reads available_seats = 1 → ok to book
Worker B: reads available_seats = 1 → ok to book
Worker A: decrements → available_seats = 0, creates booking ✓
Worker B: decrements → available_seats = -1, creates booking ✗ (double booking!)
```

This is a classic **race condition**. The fix: only one worker can operate on a given pool at a time.

### Implementation
```javascript
const LOCK_TTL_MS = 10000; // 10 seconds

async function acquireRedisLock(poolId) {
  const key = `pool:${poolId}:lock`;
  // SET key "1" NX PX 10000
  // NX = only set if Not eXists
  // PX = expiry in milliseconds
  const result = await redis.set(key, '1', 'NX', 'PX', LOCK_TTL_MS);
  return result === 'OK'; // 'OK' = acquired, null = already locked
}

async function releaseRedisLock(poolId) {
  const key = `pool:${poolId}:lock`;
  await redis.del(key);
}
```

### Why `SET NX PX` and not `SETNX` + `EXPIRE`?

`SETNX` followed by `EXPIRE` is **two commands** — not atomic. If the process crashes between them, the key exists forever with no TTL → permanent deadlock. `SET key value NX PX ttl` is a single atomic command. This was added in Redis 2.6.12 specifically to fix this pattern.

### Why 10 second TTL?

If a worker acquires the lock and then crashes before releasing it, the TTL ensures the lock auto-expires. 10 seconds gives enough time for the DB transaction to complete under any reasonable load, while being short enough that a crash doesn't block other workers for too long.

### Limitation of this approach (Redlock)

Single-node Redis lock has one weakness: if Redis itself goes down or has a network partition, locks may be lost or duplicated. The production-grade solution is **Redlock** (Redis's own distributed lock algorithm using 3+ Redis nodes with quorum). For an intern project, single-node is appropriate and defensible — just know the tradeoff.

---

## 10. k6 Load Testing — Results & What They Mean

### What was tested

The k6 script simulates concurrent booking requests against `POST /api/bookings` to measure:
- Latency percentiles under load
- Error rate (no booking should fail due to system error)
- System behavior under concurrent pool contention

### Results (latest run, post-RabbitMQ integration)

```
✓ http_req_duration p(95) = 19.66ms
✓ http_req_failed   = 0.00%
```

| Metric | Value | What it means |
|---|---|---|
| p95 latency | 19.66ms | 95% of booking requests responded within 19.66ms |
| p99 latency | ~35ms (est.) | Worst-case tail latency still sub-50ms |
| Error rate | 0% | No 4xx/5xx responses under load |

### Why p95, not average?

Average latency hides outliers. If 94 requests take 10ms and 6 take 500ms, average is ~39ms — which sounds fine. p95 = 500ms — which shows you the real problem. p95 is the standard SLO metric used in production SLAs.

### What the 19.66ms actually measures

This is the **API response time** — from the moment the request hits the server to the moment the `202 Accepted` is returned. It does NOT include the async worker processing time. The API is fast because it only does:
1. Input validation
2. DB read (pool matching)
3. DB write (create PENDING booking)
4. Publish to RabbitMQ
5. Return 202

The heavy work (Redis lock + DB transaction) happens asynchronously in the worker.

### k6 script structure
```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,           // 50 virtual users
  duration: '30s',   // for 30 seconds
};

export default function () {
  const payload = JSON.stringify({
    passengerId: 'some-uuid',
    pickup_area: 'Gomti Nagar',
    drop_area: 'Hazratganj',
    requested_time: '2026-07-01T09:00:00Z'
  });

  const res = http.post('http://localhost:3000/api/bookings', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  check(res, {
    'status is 202': (r) => r.status === 202,
  });
}
```

---

## 11. PostgreSQL Schema & Prisma

### Why PostgreSQL over MongoDB?

Bookings need **ACID transactions** — the seat decrement and booking confirmation must be atomic. MongoDB transactions exist but are less battle-tested for this use case. PostgreSQL's transaction model is the gold standard.

### Prisma specifics

**Migration workflow:**
```bash
npx prisma migrate dev --name init   # creates migration + applies
npx prisma generate                  # regenerates Prisma client
npx prisma studio                    # visual DB browser
```

**Transaction syntax used in worker:**
```javascript
await prisma.$transaction([
  prisma.ridePool.update({
    where: { id: poolId, available_seats: { gt: 0 } },
    data: { available_seats: { decrement: 1 } }
  }),
  prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'CONFIRMED' }
  })
]);
```

**Why `available_seats: { gt: 0 }` in the WHERE clause?**

This is a guard — even inside the Redis lock, even after the re-read, the transaction itself adds one more check. If somehow `available_seats` is 0 at write time, the `update` affects 0 rows. Prisma will throw (since it expects 1 row updated), and the transaction rolls back. Defense in depth.

---

## 12. Error Handling & Edge Cases

### Edge Case 1: Pool fills up between matching and queueing

Timeline:
- API matches pool P1 (2 seats available) → publishes booking for P1
- Another request matches P1 (1 seat available) → publishes booking for P1
- Worker processes both concurrently

Fix: Redis lock ensures only one worker touches P1 at a time. The second worker re-reads `available_seats` after acquiring the lock. If 0, it marks the booking as `FAILED`.

### Edge Case 2: Worker crashes mid-processing

Timeline:
- Worker receives message, acquires Redis lock
- Worker crashes before ACKing

RabbitMQ behavior: since `noAck: false`, unacknowledged messages are **redelivered** to another worker when RabbitMQ detects the consumer is gone (via heartbeat timeout). The Redis lock TTL (10s) ensures the lock will expire and the new worker can acquire it.

### Edge Case 3: RabbitMQ is down when API tries to publish

The `channel.sendToQueue` call will throw. The API should:
1. Catch the error
2. Update the booking status to `FAILED` immediately
3. Return 503 Service Unavailable

This is a known limitation of the current implementation — a proper solution would use the **Outbox Pattern**: write the message to a DB table first, then a separate process reads and publishes. This guarantees no message is lost even if the broker is down.

### Edge Case 4: Duplicate booking (same passenger, same pool)

Not currently enforced at DB level. Extension: add a unique constraint `(passengerId, ridePoolId)` in the Booking table. For interview: "I'm aware this isn't enforced yet — I'd add a unique composite index on `passengerId + ridePoolId` and handle the Prisma `P2002` unique constraint error in the worker."

---

## 13. Interview Q&A — Every Tricky Question

**Q: Why not just use a DB transaction and skip RabbitMQ entirely?**

A: You could — for low traffic. But synchronous DB transactions under high concurrency cause lock contention. RabbitMQ decouples the rate of incoming requests from the rate of DB writes. The queue acts as a buffer. 500 concurrent requests don't all hammer PostgreSQL at once — they queue up and the worker processes them at a controlled rate.

---

**Q: What happens if two workers process the same message?**

A: RabbitMQ guarantees **at-least-once delivery** — in rare network conditions, a message can be delivered twice. The Redis lock prevents both from entering the critical section simultaneously. Additionally, the Prisma `WHERE available_seats > 0` guard means the second one will fail gracefully even if the lock somehow doesn't protect it.

---

**Q: Your Redis lock — what if Redis goes down?**

A: Single-node Redis is a SPOF for the locking mechanism. If Redis goes down, no locks can be acquired and workers will fail. Short-term: workers should fall back to a pessimistic DB lock (`SELECT FOR UPDATE`) if Redis is unavailable. Long-term: use Redlock with 3+ Redis nodes for quorum-based locking.

---

**Q: Why 202 instead of 200?**

A: 200 OK implies the operation is complete. 202 Accepted means the request has been received and will be processed asynchronously. Returning 200 for an async operation would be semantically incorrect — the client would assume the booking is confirmed when it's actually still in the queue.

---

**Q: How does the client know when the booking is confirmed?**

A: Polling — `GET /api/bookings/:id` returns the current status (PENDING → CONFIRMED/FAILED). A production improvement would be WebSockets or Server-Sent Events to push the status update to the client instead of polling.

---

**Q: What is prefetch(1) and why did you use it?**

A: `prefetch(1)` limits the worker to holding one unacknowledged message at a time. Without it, RabbitMQ pushes the entire queue to the consumer's memory buffer. This causes memory spikes and defeats the purpose of having a queue. With prefetch(1), the worker processes one booking at a time — each message is only received after the previous one is ACKed.

---

**Q: What's the difference between durable queue and persistent message?**

A: Two separate things:
- **Durable queue**: the queue definition survives a RabbitMQ restart. Without this, the queue disappears on broker restart.
- **Persistent message**: the message content is written to disk. Without this, messages in the queue are lost on broker restart even if the queue survives.
You need both for true durability. RideSync uses both.

---

**Q: Why Prisma over raw SQL or TypeORM?**

A: Prisma gives type-safe query results — if the DB schema changes, TypeScript compilation catches the mismatch at build time, not runtime. TypeORM uses decorators which adds boilerplate and is harder to reason about. Raw SQL is fine for performance-critical paths but loses type safety. For this project, Prisma's balance of safety and ergonomics was the right tradeoff.

---

**Q: What would you add next?**

A: Three things in priority order:
1. **Cancellation worker** — second queue (`cancellations_q`), worker removes passenger from pool, increments `available_seats`, re-opens pool if it was FULL.
2. **Dead Letter Queue** — catch permanently failing messages for inspection and replay.
3. **Outbox pattern** — write messages to a DB table before publishing to RabbitMQ, eliminating the window where a crash between DB write and MQ publish causes data inconsistency.

---

**Q: How did you validate this works under load?**

A: k6 load test — 50 virtual users firing concurrent booking requests for 30 seconds. Results: p95 latency of 19.66ms, 0% error rate. The 0% error rate under concurrent pool contention validates that the Redis lock + worker pipeline correctly handles race conditions without double-bookings or system errors.

---

**Q: What is the difference between NACK with requeue:true vs requeue:false?**

A: `requeue: true` puts the message back at the front of the queue for immediate retry — used for transient failures (couldn't acquire lock, temporary DB timeout). `requeue: false` discards the message (or routes to DLQ if configured) — used for permanent failures (malformed message, booking passenger doesn't exist). Using `requeue: true` for permanent failures causes an infinite retry loop.

---

**Q: What isolation level does your PostgreSQL transaction use?**

A: Default is `READ COMMITTED`. For the seat decrement, this is sufficient because the Redis lock ensures only one transaction is in the critical section at a time. If we removed the Redis lock and relied purely on DB-level concurrency control, we'd need `REPEATABLE READ` or `SERIALIZABLE` to prevent the race condition — but those come with higher lock contention and potential transaction rollbacks.

---

*Built by Saurabh Tripathi — FlyRank AI Backend Intern, KIET Group of Institutions, Class of 2027*
