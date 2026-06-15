import redis from "./redis.client.js";
import { DriverStatus } from "../db/prisma-client/enums.js";

// defines what information we want Redis to hold for a driver.
export interface DriverCacheData {
  driverId: string;
  status: DriverStatus; // "AVAILABLE" | "BUSY" | "OFFLINE"
  seatsAvailable: number;
  luggageCapacity: number;
}

// Redis Set containing IDs of all currently available drivers
const AVAILABLE_DRIVERS_KEY = "available_drivers";

// Generates Redis Hash key: driver:<driverId>
const driverKey = (driverId: string) => `driver:${driverId}`;


// when a driver starts their shift.
// Stores driver details in a Redis Hash and adds to the available_drivers Set for fast matching.
export async function addDriverToCache(data: DriverCacheData): Promise<void> {
  await redis.hset(driverKey(data.driverId), {
    status: data.status,
    seatsAvailable: data.seatsAvailable,
    luggageCapacity: data.luggageCapacity,
  });

  await redis.sadd(AVAILABLE_DRIVERS_KEY, data.driverId);
}


// a driver ends their shift.
// Removes from available set and deletes the hash entirely.
export async function removeDriverFromCache(driverId: string): Promise<void> {
  await redis.srem(AVAILABLE_DRIVERS_KEY, driverId);
  await redis.del(driverKey(driverId));
}

//  driver is assigned to a new pool
// Removed from available set so no other worker picks them.
export async function markDriverBusy(driverId: string): Promise<void> {
  await redis.srem(AVAILABLE_DRIVERS_KEY, driverId);
  await redis.hset(driverKey(driverId), "status", DriverStatus.BUSY);
}

// creates a fresh pool
export async function findEligibleDriver(
  seatsNeeded: number,
  luggageCount: number
): Promise<DriverCacheData | null> {
  const driverIds = await redis.smembers(AVAILABLE_DRIVERS_KEY);

  if (driverIds.length === 0) return null;

  for (const id of driverIds) {
    const raw = await redis.hgetall(driverKey(id));

    if (!raw || !raw.status) continue;

    const seatsAvailable = Number(raw.seatsAvailable);
    const luggageCapacity = Number(raw.luggageCapacity);

    if (seatsAvailable >= seatsNeeded && luggageCapacity >= luggageCount) {
      return {
        driverId: id,
        status: raw.status as DriverStatus,
        seatsAvailable,
        luggageCapacity,
      };
    }
  }

  return null;
}

// fetch only one driver's data
export async function getDriverFromCache(
  driverId: string
): Promise<DriverCacheData | null> {
  const raw = await redis.hgetall(driverKey(driverId));

  if (!raw || !raw.status) return null;

  return {
    driverId,
    status: raw.status as DriverStatus,
    seatsAvailable: Number(raw.seatsAvailable),
    luggageCapacity: Number(raw.luggageCapacity),
  };
}