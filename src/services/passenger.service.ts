import prisma from "../db/prisma.js";

export async function createPassenger(name: string, phone: string) {
  return prisma.passenger.create({
    data: {
      name,
      phone,
    },
  });
}

export async function getPassengers() {
  return prisma.passenger.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function getPassengerById(id: string) {
  return prisma.passenger.findUnique({
    where: {
      id,
    },
  });
}
