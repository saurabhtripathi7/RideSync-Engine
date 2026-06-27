# ✈️ Airport Ride Pooling System

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-FF6600?style=flat&logo=rabbitmq&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat&logo=prisma&logoColor=white)

A backend system that groups airport passengers into shared cabs, optimizes drop-off sequences using an insertion heuristic, and dynamically prices fares based on route distance, luggage, and demand. Built as a pure backend / systems design project with no frontend.

---

## What This Project Is

When multiple passengers book rides from the same airport around the same time, this system intelligently groups them into shared cabs — respecting each passenger's maximum detour tolerance, the cab's seat and luggage capacity, and minimizing total route distance. Fares are split between pooled passengers and adjusted dynamically based on real-time demand.

The system is designed around two independently running processes: an HTTP server that responds instantly to bookings, and a worker process that handles the pooling algorithm asynchronously. Passengers poll for their match result — no WebSocket required.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| TypeScript | Type safety — catches nullable field bugs at compile time |
| Node.js + Express | HTTP server, REST API |
| PostgreSQL + Prisma | Persistent storage, ACID transactions for atomic pool insertions |
| Redis (ioredis) | Real-time driver availability, distributed locks for concurrency |
| RabbitMQ (amqplib) | Decouples HTTP layer from pooling algorithm |
| Haversine Formula | O(1) straight-line distance — no Maps API needed |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        CLIENT                           │
│           POST /rides/request                           │
│           GET  /rides/:id/status  (poll every 3s)       │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────┐
│               PROCESS 1 — server.ts                     │
│                                                         │
│  Express REST API                                       │
│  · Saves ride to PostgreSQL (status = searching)        │
│  · Publishes ride.requested → RabbitMQ                  │
│  · Returns { rideId } in under 10ms                     │
│  · Handles driver on/off duty via Redis                 │
└────────────────────────┬────────────────────────────────┘
                         │ publishes events
                         ▼
┌─────────────────────────────────────────────────────────┐
│                     RABBITMQ                            │
│                                                         │
│   ride.requested  ───────────────────────────────┐      │
│   ride.cancelled  ───────────────────────────┐   │      │
└──────────────────────────────────────────────┼───┼──────┘
                                               │   │
                         ┌─────────────────────┘   │
                         │   ┌─────────────────────┘
                         ▼   ▼
┌─────────────────────────────────────────────────────────┐
│               PROCESS 2 — worker.ts                     │
│                                                         │
│  ride.worker           cancellation.worker              │
│  · Runs insertion       · Re-routes remaining           │
│    heuristic              passengers after cancel       │
│  · Writes result        · Recalculates fares            │
│    to PostgreSQL                                        │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    DATA LAYER                           │
│                                                         │
│  PostgreSQL                    Redis                    │
│  passengers, cabs,             available_drivers (Set)  │
│  drivers, pools, rides         driver:{id} (Hash)       │
│                                lock:pool:{id} (NX lock) │
└─────────────────────────────────────────────────────────┘
```

---

## How It Works — The Core Flow

**1. Passenger books a ride**

`POST /rides/request` saves the ride to PostgreSQL with `status = searching`, computes and stores the straight-line airport-to-dropoff distance (`directDist`), publishes a `ride.requested` event to RabbitMQ, and returns `{ rideId }` immediately — the HTTP server never waits for pooling.

**2. Worker picks up the event**

The worker process consumes the message and calls `processRide(rideId)`. It fetches up to 5 currently forming pools from PostgreSQL (sorted oldest-first so longer-waiting passengers fill up first) and runs the insertion heuristic on each.

**3. Insertion heuristic**

For each forming pool, the algorithm tries inserting the new passenger at every position in the existing drop-off sequence. It picks the position that adds the least extra distance while ensuring no passenger — new or existing — exceeds their declared detour tolerance. If a valid position is found, the insertion is committed in a single atomic database transaction.

**4. No pool fits → new pool**

If no forming pool can accommodate the new ride, the worker picks an available driver from Redis (filtered by seat and luggage capacity) and creates a fresh pool.

**5. Passenger polls for result**

```
GET /rides/:id/status  →  { status: "searching" }   (worker still running)
GET /rides/:id/status  →  { status: "matched", fare, dropOrder, driver }
```

The client polls every 3 seconds. The worker updates the DB; the next poll sees the result.

---

## Pooling Algorithm

All rides start from the same airport — so the only variable is the drop-off sequence. The insertion heuristic finds the optimal position to insert a new passenger into an existing route.

**Insertion positions for a 3-passenger pool:**

```
Existing route:  Airport → A → B → C

Insert D at 0:   Airport → D → A → B → C   (A, B, C all get longer routes)
Insert D at 1:   Airport → A → D → B → C   (B, C affected — A unchanged)
Insert D at 2:   Airport → A → B → D → C   (only C affected)
Insert D at 3:   Airport → A → B → C → D   (nobody affected — safest for existing)
```

For each position the algorithm checks:
- Does D's detour stay within D's `maxDetourPct`?
- Does every affected existing passenger still stay within their own `maxDetourPct`?

The position with the lowest extra distance that satisfies all constraints wins. If no position is valid, this pool is skipped.

**Concurrency:** Before modifying any pool, the worker acquires a Redis `NX` lock (`SET lock:pool:{id} NX EX 5`). If two workers pick the same pool simultaneously, only one proceeds — the other re-runs the full algorithm on fresh data.

---

## Folder Structure

```
src/
├── config/
│   └── constants.ts              # All tunable values — airport coords, rates, timeouts
├── db/
│   └── prisma.client.ts          # Singleton Prisma client
├── cache/
│   ├── redis.client.ts           # Singleton ioredis client
│   ├── driver.cache.ts           # Driver on/off duty, find eligible driver
│   └── pool.cache.ts             # Acquire / release pool lock
├── queues/
│   ├── queue.connection.ts       # RabbitMQ connection + queue assertions
│   └── ride.publisher.ts         # Publish ride.requested / ride.cancelled
├── services/
│   ├── haversine.ts              # Distance math — O(1), no dependencies
│   ├── pooling.service.ts        # Insertion heuristic + new pool creation
│   ├── pricing.service.ts        # Dynamic fare formula
│   ├── ride.service.ts           # Ride CRUD + status
│   ├── driver.service.ts         # Driver registration + duty toggling
│   ├── passenger.service.ts      # Passenger registration
│   └── cab.service.ts            # Cab registration
├── workers/
│   ├── ride.worker.ts            # Consumes ride.requested → runs pooling
│   └── cancellation.worker.ts    # Consumes ride.cancelled → re-routes pool
├── routes/
│   ├── ride.routes.ts
│   ├── driver.routes.ts
│   ├── passenger.routes.ts
│   └── cab.routes.ts
├── controllers/
│   ├── ride.controller.ts        # Validates input, calls service, publishes events
│   ├── driver.controller.ts
│   ├── passenger.controller.ts
│   └── cab.controller.ts
├── app.ts                        # Express setup + route mounting
├── server.ts                     # Process 1 — HTTP server entry point
└── worker.ts                     # Process 2 — Worker entry point

prisma/
├── schema.prisma                 # DB models + indexes
└── seed.ts                       # Test data — cabs, drivers, passengers
```

---

## API Reference

### Passengers

**Register a passenger**
```
POST /passengers
```
```json
{ "name": "Ananya Sharma", "phone": "9000000001" }
```
```json
201 → { "id": "uuid", "name": "Ananya Sharma", "phone": "9000000001", "createdAt": "..." }
```

---

### Cabs

**Register a cab**
```
POST /cabs
```
```json
{ "plateNumber": "PB01AB1234", "totalSeats": 4, "luggageCapacity": 4, "cabType": "suv" }
```
```json
201 → { "id": "uuid", "plateNumber": "PB01AB1234", "totalSeats": 4, "luggageCapacity": 4, "cabType": "suv" }
```

---

### Drivers

**Register a driver**
```
POST /drivers
```
```json
{ "name": "Rajesh Kumar", "phone": "9876543210", "cabId": "uuid" }
```
```json
201 → { "id": "uuid", "name": "Rajesh Kumar", "phone": "9876543210", "cabId": "uuid" }
400 → { "error": "Cab already assigned to another driver" }
```

**Go on duty**
```
POST /drivers/duty
```
```json
{ "driverId": "uuid" }
```
```json
200 → { "message": "Driver is now on duty" }
```

**Go off duty**
```
DELETE /drivers/duty
```
```json
{ "driverId": "uuid" }
```
```json
200 → { "message": "Driver is now off duty" }
```

---

### Rides

**Request a ride**
```
POST /rides/request
```
```json
{
  "passengerId": "uuid",
  "dropoffLat": 30.7410,
  "dropoffLng": 76.7849,
  "seatsNeeded": 1,
  "luggageCount": 1,
  "maxDetourPct": 30
}
```
```json
202 → { "rideId": "uuid", "status": "searching" }
400 → { "error": "Passenger not found" }
```

`maxDetourPct` — the maximum percentage longer than the direct route the passenger will tolerate. E.g. `30` means they accept up to 30% extra travel distance.

**Poll ride status**
```
GET /rides/:id/status
```
```json
200 (searching) → { "rideId": "uuid", "status": "searching" }

200 (matched) → {
  "rideId": "uuid",
  "status": "matched",
  "dropOrder": 2,
  "poolSize": 3,
  "fare": 145.50,
  "driver": {
    "name": "Rajesh Kumar",
    "phone": "9876543210",
    "cab": { "plate": "PB01AB1234", "type": "suv" }
  }
}
```

`dropOrder` — this passenger's position in the drop sequence (1 = dropped off first).  
`poolSize` — total passengers in this shared cab.

**Cancel a ride**
```
POST /rides/:id/cancel
```
```json
200 → { "message": "Ride cancelled" }
400 → { "error": "Cannot cancel a completed ride" }
```
If the ride was in a pool, the remaining passengers are automatically re-routed and their fares recalculated.

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL running on port 5432
- Redis running on port 6379
- RabbitMQ running on port 5672

### Install

```bash
npm install
npm install -D @types/node concurrently nodemon ts-node
```

### Configure environment

Create a `.env` file in the root:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/airport_pooling
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://localhost:5672
PORT=3000
```

### Migrate and seed

```bash
npx prisma migrate dev
npx ts-node prisma/seed.ts
```

The seed script prints all generated IDs — copy them for use in Postman.

### Run

```bash
npm run dev
```

This starts both the HTTP server (`server.ts`) and the worker process (`worker.ts`) concurrently.

To run them separately:

```bash
npm run dev:server   # terminal 1
npm run dev:worker   # terminal 2
```

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:password@localhost:5432/airport_pooling` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `RABBITMQ_URL` | RabbitMQ connection string | `amqp://localhost:5672` |
| `PORT` | HTTP server port | `3000` |

Algorithm constants (`AIRPORT_LAT`, `BASE_RATE_PER_KM`, `POOL_WINDOW_SECONDS`, etc.) live in `src/config/constants.ts` — not in `.env` because they are code constants, not environment-specific values.

---

## Key Design Decisions

**Two independent processes instead of one**
The HTTP server and the pooling workers have different scaling needs. Under high load you want more workers processing ride requests, not more HTTP servers. Running them as separate processes (`server.ts` and `worker.ts`) means they scale independently and share no in-memory state — only the database and Redis.

**HTTP returns immediately, pooling is async**
Making `POST /rides/request` wait for the pooling algorithm would block the server thread, create slow response times, and couple the HTTP layer to algorithm performance. Publishing to RabbitMQ and returning instantly keeps the API fast and the system resilient — if the worker crashes, rides queue up and get processed when it recovers.

**Polling over WebSocket**
The client knows exactly when to ask — 3 seconds after booking. WebSocket would add persistent connection management with zero benefit. The pooling algorithm completes well within 3 seconds, making polling the right and simpler choice.

**Redis for driver availability, PostgreSQL for pools**
Driver availability is live state that changes on every duty toggle — Redis is purpose-built for this. Pools, however, are complex objects with 12 fields that change atomically on every insertion. Caching pools in Redis alongside PostgreSQL would require keeping both in sync — a source of bugs with no real speed gain since the indexed DB query returns in under 1ms.

**Distributed locking on pool modification**
Two workers processing simultaneous ride requests could both find the same pool valid and both attempt to insert — resulting in overbooking. A Redis `SET NX EX 5` lock ensures only one worker modifies a pool at a time. The 5-second auto-expiry means no pool stays locked forever if a worker crashes mid-operation.

**Detour tolerance per passenger, not per pool**
Each passenger declares their own `maxDetourPct` at booking time. The algorithm checks both the new passenger's tolerance and every existing passenger's tolerance at each candidate insertion position. This ensures the pooling never silently degrades anyone's ride quality beyond what they agreed to.
