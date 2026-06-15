import prisma from "../db/prisma.js";
import { CabType, } from "../db/prisma-client/enums.js";

export async function createCab(
  plateNumber: string,
  totalSeats: number,
  luggageCapacity: number,
  cabType: CabType,
) {
  return prisma.cab.create({
    data: {
      plateNumber,
      totalSeats,
      luggageCapacity,
      cabType,
    },
  });
}

export async function getCabs() {
  return prisma.cab.findMany();
}

export async function getCabById(id: string) {
  return prisma.cab.findUnique({
    where: {
      id,
    },
    include: {
      driver: true,
    },
  });
}