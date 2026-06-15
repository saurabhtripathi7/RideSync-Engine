import prisma from "../db/prisma.js";

export async function createRide(
  passengerId: string,
  dropoffLat: number,
  dropoffLng: number,
  seatsNeeded: number,
  luggageCount: number,
  maxDetourPct: number,
  directDist: number,
) {
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
    where: {
      id,
    },
    include: {
      passenger: true,
      pool: true,
    },
  });
}
