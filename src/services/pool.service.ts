import prisma from "../db/prisma.js";

export async function createPool(
  driverId: string,
  cabId: string
) {
  return prisma.pool.create({
    data: {
      driverId,
      cabId,
    },
  });
}

export async function getFormingPools() {
  return prisma.pool.findMany({
    where: {
      status: "FORMING",
    },
    include: {
      cab: true,
      rides: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });
}