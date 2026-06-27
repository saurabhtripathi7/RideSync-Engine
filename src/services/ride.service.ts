import prisma from "../db/prisma.js";
import { haversine } from "./haversine.js";
import { AIRPORT_LAT, AIRPORT_LNG } from "../config/constants.js";
import { RideStatus } from "../db/prisma-client/enums.js";

export async function createRide(
  passengerId: string,
  dropoffLat: number,
  dropoffLng: number,
  seatsNeeded: number,
  luggageCount: number,
  maxDetourPct: number,
) {
  // Calculate server-side — caller should never supply this
  const directDist = haversine(AIRPORT_LAT, AIRPORT_LNG, dropoffLat, dropoffLng);

  return prisma.ride.create({
    data: {
      passengerId,
      dropoffLat,
      dropoffLng,
      seatsNeeded,
      luggageCount,
      maxDetourPct,
      directDist,
    },
  });
}

export async function getRides() {
  return prisma.ride.findMany({
    include: {
      passenger: true,
      pool: true,
    },
  });
}

export async function getRideById(id: string) {
  return prisma.ride.findUnique({
    where: { id },
    include: {
      passenger: true,
      pool: true,
    },
  });
}

export async function getRideStatus(rideId: string) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      pool: {
        include: {
          driver: { include: { cab: true } },
        },
      },
    },
  });

  if (!ride) throw new Error("Ride not found");

  // Still searching — don't expose pool info yet
  if (ride.status === RideStatus.SEARCHING) {
    return { rideId: ride.id, status: ride.status };
  }

  const poolSize = ride.poolId
    ? await prisma.ride.count({
        where: {
          poolId: ride.poolId,
          status: { not: RideStatus.CANCELLED },
        },
      })
    : null;

  return {
    rideId: ride.id,
    status: ride.status,
    dropOrder: ride.dropOrder,
    fare: ride.fare,
    poolSize,
    driver: ride.pool
      ? {
          name: ride.pool.driver.name,
          phone: ride.pool.driver.phone,
          cab: {
            plate: ride.pool.driver.cab.plateNumber,
            type: ride.pool.driver.cab.cabType,
          },
        }
      : null,
  };
}