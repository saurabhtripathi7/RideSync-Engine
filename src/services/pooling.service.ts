import prisma from "../db/prisma.js";
import { haversine } from "./haversine.js";
import { calculateFare } from "./pricing.service.js";
import { acquirePoolLock, releasePoolLock } from "../cache/pool.cache.js";
import { findEligibleDriver, markDriverBusy } from "../cache/driver.cache.js";
import {
  AIRPORT_LAT,
  AIRPORT_LNG,
  POOL_WINDOW_SECONDS,
  MAX_POOLS_TO_CHECK,
} from "../config/constants.js";

// ACTIVE | CANCELLED | COMPLETED | FORMING
import { PoolStatus, RideStatus } from "../db/prisma-client/enums.js";

interface RideInput {
  id: string;
  dropoffLat: number;
  dropoffLng: number;
  seatsNeeded: number;
  luggageCount: number;
  maxDetourPct: number;
  directDist: number;
}

interface PooledRide {
  id: string;
  currentRouteDist: number;
  directDist: number;
  maxDetourPct: number;
  dropOrder: number;
  luggageCount: number;
}

async function getFormingPools() {
  const cutoff = new Date(Date.now() - POOL_WINDOW_SECONDS * 1000);

  return prisma.pool.findMany({
    where: {
      status: PoolStatus.FORMING,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_POOLS_TO_CHECK,
    include: { cab: true },
  });
}

// Fetch all active rides in a pool and convert them into
// a lightweight format used by the route insertion algorithm.
async function getPooledRides(poolId: string): Promise<PooledRide[]> {
  // Get non-cancelled rides ordered by current drop sequence.
  const rides = await prisma.ride.findMany({
    where: {
      poolId,
      status: {
        not: PoolStatus.CANCELLED,
      },
    },
    orderBy: {
      dropOrder: "asc",
    },
  });

  return (
    rides

      // Ignore rides that haven't been fully assigned a route yet. (default -> null)
      .filter((r) => r.currentRouteDist !== null && r.dropOrder !== null)

      // Keep only fields required for route optimization.
      .map((r) => ({
        id: r.id,
        currentRouteDist: r.currentRouteDist as number,
        directDist: r.directDist,
        maxDetourPct: r.maxDetourPct,
        dropOrder: r.dropOrder as number,
        luggageCount: r.luggageCount,
      }))
  );
}

/*
 * Route Insertion Heuristic
 *
 * Goal:
 * Find the best position to insert a new ride into an existing pool.
 *
 * For each possible insertion position:
 * 1. Calculate the additional route distance introduced.
 * 2. Check if the new passenger's detour stays within their limit.
 * 3. Check if existing passengers' detours stay within their limits.
 * 4. Among all valid positions, choose the one with the least extra distance.
 *
 * Returns:
 *   { index, extraDist } -> Best insertion position
 *   null                 -> No valid insertion exists
 */
function findBestInsertionIndex(
  pool: {
    routeOrder: string;
    routeDropoffLats: string;
    routeDropoffLngs: string;
    totalRouteDist: number;
  },
  existingRides: PooledRide[],
  newRide: RideInput,
): { index: number; extraDist: number } | null {
  // Existing route coordinates stored as JSON strings in the DB.
  const lats: number[] = JSON.parse(pool.routeDropoffLats);
  const lngs: number[] = JSON.parse(pool.routeDropoffLngs);

  // Number of existing dropoff points in the route.
  const k = lats.length;

  let bestIndex: number | null = null;
  let bestExtraDist = Infinity;

  // Try inserting the new passenger at every possible route position.
  for (let i = 0; i <= k; i++) {
    // Determine neighboring points around the insertion position.
    const prevLat: number = i === 0 ? AIRPORT_LAT : lats[i - 1]!;
    const prevLng: number = i === 0 ? AIRPORT_LNG : lngs[i - 1]!;
    const nextLat: number | null = i === k ? null : lats[i]!;
    const nextLng: number | null = i === k ? null : lngs[i]!;

    // Calculate how much extra route distance this insertion adds.
    let extraDist: number;

    // Insert at end of route.
    if (nextLat === null || nextLng === null) {
      extraDist = haversine(
        prevLat,
        prevLng,
        newRide.dropoffLat,
        newRide.dropoffLng,
      );
    } else {
      // Insert between two existing stops.
      // Extra distance =
      // (prev -> new + new -> next) - (prev -> next)
      extraDist =
        haversine(prevLat, prevLng, newRide.dropoffLat, newRide.dropoffLng) +
        haversine(newRide.dropoffLat, newRide.dropoffLng, nextLat, nextLng) -
        haversine(prevLat, prevLng, nextLat, nextLng);
    }

    // Distance traveled before reaching the new passenger.
    let prefixDist = 0;

    for (let j = 0; j < i; j++) {
      const fromLat: number = j === 0 ? AIRPORT_LAT : lats[j - 1]!;

      const fromLng: number = j === 0 ? AIRPORT_LNG : lngs[j - 1]!;

      prefixDist += haversine(fromLat, fromLng, lats[j]!, lngs[j]!);
    }

    // Route distance the new passenger experiences.
    const dRouteDist =
      prefixDist +
      haversine(prevLat, prevLng, newRide.dropoffLat, newRide.dropoffLng);

    // New passenger's detour percentage.
    const dDetour = (dRouteDist - newRide.directDist) / newRide.directDist;

    // Reject positions that exceed the new passenger's detour limit.
    if (dDetour > newRide.maxDetourPct / 100) {
      continue;
    }

    let allValid = true;

    // Verify that existing passengers remain within
    // their allowed detour limits after insertion.
    for (let j = i; j < existingRides.length; j++) {
      const p = existingRides[j];

      if (p == undefined) continue;

      const simulatedDist = p.currentRouteDist + extraDist;

      const pDetour = (simulatedDist - p.directDist) / p.directDist;

      if (pDetour > p.maxDetourPct / 100) {
        allValid = false;
        break;
      }
    }

    // Keep the valid insertion that adds
    // the least additional route distance.
    if (allValid && extraDist < bestExtraDist) {
      bestIndex = i;
      bestExtraDist = extraDist;
    }
  }

  // No valid insertion position satisfies all constraints.
  if (bestIndex === null) {
    return null;
  }

  return {
    index: bestIndex,
    extraDist: bestExtraDist,
  };
}

async function commitInsertion(
  pool: {
    id: string;
    routeOrder: string;
    routeDropoffLats: string;
    routeDropoffLngs: string;
    totalRouteDist: number;
    totalSeatsUsed: number;
    totalLuggageUsed: number;
  },
  existingRides: PooledRide[],
  newRide: RideInput,
  insertionIndex: number,
  extraDist: number,
  poolSize: number,
): Promise<void> {
  const routeOrder: string[] = JSON.parse(pool.routeOrder);
  const lats: number[] = JSON.parse(pool.routeDropoffLats);
  const lngs: number[] = JSON.parse(pool.routeDropoffLngs);

  routeOrder.splice(insertionIndex, 0, newRide.id);
  lats.splice(insertionIndex, 0, newRide.dropoffLat);
  lngs.splice(insertionIndex, 0, newRide.dropoffLng);

  let prefixDist = 0;
  for (let j = 0; j < insertionIndex; j++) {
    const fromLat: number = j === 0 ? AIRPORT_LAT : lats[j - 1]!;
    const fromLng: number = j === 0 ? AIRPORT_LNG : lngs[j - 1]!;
    prefixDist += haversine(fromLat, fromLng, lats[j]!, lngs[j]!);
  }
  const prevLat: number =
    insertionIndex === 0 ? AIRPORT_LAT : lats[insertionIndex - 1]!;
  const prevLng: number =
    insertionIndex === 0 ? AIRPORT_LNG : lngs[insertionIndex - 1]!;
  const newRideRouteDist =
    prefixDist +
    haversine(prevLat, prevLng, newRide.dropoffLat, newRide.dropoffLng);

  const newFare = await calculateFare({
    currentRouteDist: newRideRouteDist,
    directDist: newRide.directDist,
    luggageCount: newRide.luggageCount,
    passengersInPool: poolSize,
  });

  const affectedRides = existingRides.filter((_, idx) => idx >= insertionIndex);

  await prisma.$transaction(async (tx) => {
    await tx.pool.update({
      where: { id: pool.id },
      data: {
        routeOrder: JSON.stringify(routeOrder),
        routeDropoffLats: JSON.stringify(lats),
        routeDropoffLngs: JSON.stringify(lngs),
        totalRouteDist: pool.totalRouteDist + extraDist,
        totalSeatsUsed: pool.totalSeatsUsed + newRide.seatsNeeded,
        totalLuggageUsed: pool.totalLuggageUsed + newRide.luggageCount,
      },
    });

    for (const p of affectedRides) {
      const updatedRouteDist = p.currentRouteDist + extraDist;
      const updatedFare = await calculateFare({
        currentRouteDist: updatedRouteDist,
        directDist: p.directDist,
        luggageCount: p.luggageCount,
        passengersInPool: poolSize,
      });

      await tx.ride.update({
        where: { id: p.id },
        data: {
          currentRouteDist: updatedRouteDist,
          dropOrder: p.dropOrder + 1,
          fare: updatedFare,
        },
      });
    }

    await tx.ride.update({
      where: { id: newRide.id },
      data: {
        poolId: pool.id,
        status: RideStatus.MATCHED,
        currentRouteDist: newRideRouteDist,
        dropOrder: insertionIndex + 1,
        fare: newFare,
      },
    });
  });
}

// ─── Create New Pool

async function createNewPool(ride: RideInput): Promise<void> {
  const driver = await findEligibleDriver(ride.seatsNeeded, ride.luggageCount);

  if (!driver) return; 
  await markDriverBusy(driver.driverId);

  const driverRecord = await prisma.driver.findUnique({
    where: { id: driver.driverId },
    include: { cab: true },
  });

  if (!driverRecord) return;

  const directDistToDropoff = haversine(
    AIRPORT_LAT,
    AIRPORT_LNG,
    ride.dropoffLat,
    ride.dropoffLng
  );

  const fare = await calculateFare({
    currentRouteDist: directDistToDropoff,
    directDist: ride.directDist,
    luggageCount: ride.luggageCount,
    passengersInPool: 1,
  });

  await prisma.$transaction(async (tx) => {
    const pool = await tx.pool.create({
      data: {
        cabId: driverRecord.cabId,
        driverId: driver.driverId,
        status: "FORMING",
        totalSeatsUsed: ride.seatsNeeded,
        totalLuggageUsed: ride.luggageCount,
        routeOrder: JSON.stringify([ride.id]),
        routeDropoffLats: JSON.stringify([ride.dropoffLat]),
        routeDropoffLngs: JSON.stringify([ride.dropoffLng]),
        totalRouteDist: directDistToDropoff,
      },
    });

    await tx.ride.update({
      where: { id: ride.id },
      data: {
        poolId: pool.id,
        status: "MATCHED",
        currentRouteDist: directDistToDropoff,
        dropOrder: 1,
        fare,
      },
    });
  });
}

export async function processRide(rideId: string): Promise<void> {
  const ride = await prisma.ride.findUnique({ where: { id: rideId } });

  if (!ride || ride.status !== RideStatus.SEARCHING) return;

  const rideInput: RideInput = {
    id: ride.id,
    dropoffLat: ride.dropoffLat,
    dropoffLng: ride.dropoffLng,
    seatsNeeded: ride.seatsNeeded,
    luggageCount: ride.luggageCount,
    maxDetourPct: ride.maxDetourPct,
    directDist: ride.directDist,
  };

  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pools = await getFormingPools();
    if (pools.length === 0) break;

    let bestPoolId: string | null = null;
    let bestInsertionIndex = 0;
    let bestExtraDist = Infinity;

    for (const pool of pools) {
      if (pool.totalSeatsUsed + rideInput.seatsNeeded > pool.cab.totalSeats) continue;
      if (pool.totalLuggageUsed + rideInput.luggageCount > pool.cab.luggageCapacity) continue;

      const existingRides = await getPooledRides(pool.id);
      const result = findBestInsertionIndex(pool, existingRides, rideInput);

      if (result && result.extraDist < bestExtraDist) {
        bestPoolId = pool.id;
        bestInsertionIndex = result.index;
        bestExtraDist = result.extraDist;
      }
    }

    if (!bestPoolId) break; 

    const workerId = `worker-${Date.now()}-${Math.random()}`;
    const acquired = await acquirePoolLock(bestPoolId, workerId);

    if (!acquired) continue;

    try {
      const freshPool = await prisma.pool.findUnique({
        where: { id: bestPoolId },
        include: { cab: true },
      });

      if (!freshPool || freshPool.status !== PoolStatus.FORMING) continue;

      if (freshPool.totalSeatsUsed + rideInput.seatsNeeded > freshPool.cab.totalSeats) continue;
      if (freshPool.totalLuggageUsed + rideInput.luggageCount > freshPool.cab.luggageCapacity) continue;

      const freshRides = await getPooledRides(bestPoolId);
      const freshResult = findBestInsertionIndex(freshPool, freshRides, rideInput);

      if (!freshResult) continue;
      try {
        await commitInsertion(
          freshPool,
          freshRides,
          rideInput,
          freshResult.index,
          freshResult.extraDist,
          freshRides.length + 1
        );
        return;
      } catch (err) {
        console.error(`[pooling] commitInsertion FAILED:`, err);
        continue;
      }

      return; // successfully inserted
    } finally {
      await releasePoolLock(bestPoolId);
    }
  }

  await createNewPool(rideInput);
}