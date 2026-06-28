import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

// ── Custom Metrics ────────────────────────────────────────────
const matchLatency = new Trend("match_latency_ms", true);
const matchedRides = new Counter("matched_rides");
const unmatchedRides = new Counter("unmatched_rides");

// ── Test Config ───────────────────────────────────────────────
export const options = {
  scenarios: {
    ride_requests: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 10 }, // ramp up to 10 virtual users
        { duration: "30s", target: 10 }, // hold at 10
        { duration: "10s", target: 0  }, // ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration:  ["p(95)<500"],   // 95% of HTTP requests under 500ms
    match_latency_ms:   ["p(90)<5000"],  // 90% of rides matched within 5s
    http_req_failed:    ["rate<0.01"],   // less than 1% errors
  },
};

// ── Passenger IDs from your seed ─────────────────────────────
const PASSENGER_IDS = [
  "084e2e12-63a3-41e6-97ba-b5303118813b", // Aarav Sharma
  "d6a1aabe-7662-446c-b163-86c5e935c8ed", // Priya Mehta
  "1245767f-1d68-4d0a-a10f-c83e12cfb953", // Rohan Verma
  "f1221185-bae1-4e95-8b64-3982a2074200", // Sneha Gupta
  "2dd9fb17-e6ec-40ac-a0e4-282db0274cf7", // Karan Patel
  "940938ac-0000-481e-96b1-2491506e6d7a", // Divya Singh
  "2db0cbe1-6ce5-4d31-8ec0-73e249a127af", // Amit Joshi
  "c6a51a55-fab1-4b92-a191-7c229f9a6988", // Neha Agarwal
  "faf6c711-162c-4ebf-a7a9-257f598123d7", // Vikram Rao
  "66196bcd-e374-43d6-a4b1-7454874ff834", // Pooja Nair
];

// Noida/Gurgaon area dropoff coordinates (realistic airport cab destinations)
const DROPOFF_POINTS = [
  { lat: 28.5355, lng: 77.3910 }, // Noida Sector 62
  { lat: 28.4595, lng: 77.0266 }, // Gurgaon Cyber City
  { lat: 28.6139, lng: 77.2090 }, // Central Delhi
  { lat: 28.5700, lng: 77.3200 }, // Noida Sector 18
  { lat: 28.4089, lng: 77.3178 }, // Faridabad
  { lat: 28.6800, lng: 77.1200 }, // North Delhi
  { lat: 28.5008, lng: 77.4098 }, // Greater Noida
  { lat: 28.4744, lng: 77.5040 }, // Noida Extension
];

const BASE_URL = "http://localhost:3000";
const HEADERS  = { "Content-Type": "application/json" };

// ── Main Test Function (runs once per VU per iteration) ───────
export default function () {
  // Pick random passenger and dropoff
  const passengerId = PASSENGER_IDS[Math.floor(Math.random() * PASSENGER_IDS.length)];
  const dropoff     = DROPOFF_POINTS[Math.floor(Math.random() * DROPOFF_POINTS.length)];

  const bookStart = Date.now();

  // Step 1: Book a ride
  const bookRes = http.post(
    `${BASE_URL}/rides/request`,
    JSON.stringify({
      passengerId,
      dropoffLat:  dropoff.lat,
      dropoffLng:  dropoff.lng,
      seatsNeeded: 1,
      luggageCount: 1,
      maxDetourPct: 30,
    }),
    { headers: HEADERS, tags: { name: "book_ride" } }
  );

  check(bookRes, {
    "book: status 202": (r) => r.status === 202,
    "book: has rideId": (r) => JSON.parse(r.body).rideId !== undefined,
  });

  if (bookRes.status !== 202) return;

  const rideId = JSON.parse(bookRes.body).rideId;

  // Step 2: Poll for MATCHED status (max 10s, every 500ms)
  let matched = false;

  for (let i = 0; i < 20; i++) {
    sleep(0.5);

    const statusRes = http.get(
      `${BASE_URL}/rides/${rideId}/status`,
      { tags: { name: "poll_status" } }
    );

    if (statusRes.status !== 200) continue;

    const body = JSON.parse(statusRes.body);

    if (body.status === "MATCHED") {
      const latency = Date.now() - bookStart;
      matchLatency.add(latency);
      matchedRides.add(1);
      matched = true;
      break;
    }
  }

  if (!matched) {
    unmatchedRides.add(1);
  }

  sleep(1);
}