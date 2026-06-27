import prisma from "../src/db/prisma.js";
import { CabType } from "../src/db/prisma-client/enums.js";

async function main() {
  console.log("Seeding database...");

  // ── Passengers ───────────────────────────────────────────────
  const passengers = await Promise.all([
    prisma.passenger.upsert({
      where: { phone: "9810001001" },
      update: {},
      create: { name: "Aarav Sharma",   phone: "9810001001" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001002" },
      update: {},
      create: { name: "Priya Mehta",    phone: "9810001002" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001003" },
      update: {},
      create: { name: "Rohan Verma",    phone: "9810001003" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001004" },
      update: {},
      create: { name: "Sneha Gupta",    phone: "9810001004" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001005" },
      update: {},
      create: { name: "Karan Patel",    phone: "9810001005" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001006" },
      update: {},
      create: { name: "Divya Singh",    phone: "9810001006" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001007" },
      update: {},
      create: { name: "Amit Joshi",     phone: "9810001007" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001008" },
      update: {},
      create: { name: "Neha Agarwal",   phone: "9810001008" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001009" },
      update: {},
      create: { name: "Vikram Rao",     phone: "9810001009" },
    }),
    prisma.passenger.upsert({
      where: { phone: "9810001010" },
      update: {},
      create: { name: "Pooja Nair",     phone: "9810001010" },
    }),
  ]);

  console.log(`✓ ${passengers.length} passengers`);

  // ── Cabs ─────────────────────────────────────────────────────
  const cabsData = [
    { plateNumber: "DL01AB1001", totalSeats: 4, luggageCapacity: 4, cabType: CabType.SEDAN },
    { plateNumber: "DL01AB1002", totalSeats: 4, luggageCapacity: 4, cabType: CabType.SEDAN },
    { plateNumber: "DL01AB1003", totalSeats: 4, luggageCapacity: 4, cabType: CabType.SEDAN },
    { plateNumber: "DL01AB1004", totalSeats: 6, luggageCapacity: 6, cabType: CabType.SUV   },
    { plateNumber: "DL01AB1005", totalSeats: 6, luggageCapacity: 6, cabType: CabType.SUV   },
    { plateNumber: "DL01AB1006", totalSeats: 6, luggageCapacity: 6, cabType: CabType.SUV   },
    { plateNumber: "DL01AB1007", totalSeats: 8, luggageCapacity: 8, cabType: CabType.VAN   },
    { plateNumber: "DL01AB1008", totalSeats: 8, luggageCapacity: 8, cabType: CabType.VAN   },
    { plateNumber: "DL01AB1009", totalSeats: 4, luggageCapacity: 4, cabType: CabType.SEDAN },
    { plateNumber: "DL01AB1010", totalSeats: 6, luggageCapacity: 6, cabType: CabType.SUV   },
  ];

  const cabs = await Promise.all(
    cabsData.map((c) =>
      prisma.cab.upsert({
        where: { plateNumber: c.plateNumber },
        update: {},
        create: c,
      })
    )
  );

  console.log(`✓ ${cabs.length} cabs`);

  // ── Drivers (each linked to one cab) ─────────────────────────
  const driversData = [
    { name: "Rajan Kumar",   phone: "9910001001", cabIndex: 0 },
    { name: "Suresh Yadav",  phone: "9910001002", cabIndex: 1 },
    { name: "Manoj Tiwari",  phone: "9910001003", cabIndex: 2 },
    { name: "Deepak Singh",  phone: "9910001004", cabIndex: 3 },
    { name: "Rakesh Mishra", phone: "9910001005", cabIndex: 4 },
    { name: "Sanjay Dubey",  phone: "9910001006", cabIndex: 5 },
    { name: "Anil Pandey",   phone: "9910001007", cabIndex: 6 },
    { name: "Vijay Sharma",  phone: "9910001008", cabIndex: 7 },
    { name: "Mukesh Gupta",  phone: "9910001009", cabIndex: 8 },
    { name: "Rajesh Verma",  phone: "9910001010", cabIndex: 9 },
  ];

  const drivers = await Promise.all(
    driversData.map((d) =>
      prisma.driver.upsert({
        where: { phone: d.phone },
        update: {},
        create: {
          name:  d.name,
          phone: d.phone,
          cabId: cabs[d.cabIndex]!.id,
        },
      })
    )
  );

  console.log(`✓ ${drivers.length} drivers`);
  console.log("\nSeed complete.");
  console.log("\nPassenger IDs (use these in POST /rides/request):");
  passengers.forEach((p) => console.log(`  ${p.name}: ${p.id}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });