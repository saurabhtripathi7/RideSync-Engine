import prisma from "../db/prisma.js";

export async function createDriver(name: string, phone: string, cabId: string) {
  return prisma.driver.create({
    data: {
      name,
      phone,
      cabId,
    },
  });
}

export async function getDrivers() {
  return prisma.driver.findMany({
    include: {
      cab: true,
    },
  });
}

export async function getDriverById(id: string) {
  return prisma.driver.findUnique({
    where: {
      id,
    },
    include: {
      cab: true,
    },
  });
}