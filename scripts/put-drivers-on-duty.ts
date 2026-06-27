import prisma from "../src/db/prisma.js";
import redis from "../src/cache/redis.client.js";
import { DriverStatus } from "../src/db/prisma-client/enums.js";

const AVAILABLE_DRIVERS_KEY = "available_drivers";
const driverKey = (id: string) => `driver:${id}`;

async function main() {
  const drivers = await prisma.driver.findMany({
    include: { cab: true },
  });

  if (drivers.length === 0) {
    console.log("No drivers found. Run seed first: npm run db:seed");
    process.exit(1);
  }

  const pipeline = redis.pipeline();

  for (const driver of drivers) {
    // Add to available set
    pipeline.sadd(AVAILABLE_DRIVERS_KEY, driver.id);

    // Write the hash that findEligibleDriver() reads
    pipeline.hset(driverKey(driver.id), {
      status: DriverStatus.AVAILABLE,
      seatsAvailable: driver.cab.totalSeats,
      luggageCapacity: driver.cab.luggageCapacity,
    });

    console.log(
      `  + ${driver.name} (${driver.cab.cabType}) seats=${driver.cab.totalSeats} luggage=${driver.cab.luggageCapacity} → Redis`
    );
  }

  await pipeline.exec();

  const count = await redis.scard(AVAILABLE_DRIVERS_KEY);
  console.log(`\n✓ ${count} drivers now available in Redis`);

  await redis.quit();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});