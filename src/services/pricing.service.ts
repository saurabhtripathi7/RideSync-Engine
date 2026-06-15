import prisma from "../db/prisma.js";
import redis from "../cache/redis.client.js";
import { RideStatus } from "../db/prisma-client/enums.js";
import {
  BASE_RATE_PER_KM,
  LUGGAGE_RATE,
  DETOUR_PENALTY_RATE,
  MAX_DEMAND_MULTIPLIER,
} from "../config/constants.js";

interface FareInput {
  currentRouteDist: number;
  directDist: number;
  luggageCount: number;
  passengersInPool: number;
}

async function getDemandMultiplier(): Promise<number> {
  const activeRides = await prisma.ride.count({
    where: { status: { in: [RideStatus.SEARCHING, RideStatus.MATCHED] } },
  });

  const availableDriverCount = await redis.scard("available_drivers");

  if (availableDriverCount === 0) return MAX_DEMAND_MULTIPLIER;

  const multiplier = activeRides / availableDriverCount;

  return Math.min(multiplier, MAX_DEMAND_MULTIPLIER);
}

export async function calculateFare(input: FareInput): Promise<number> {
  const { currentRouteDist, directDist, luggageCount, passengersInPool } =
    input;

  // Base cost for the full route distance this passenger travels
  const baseFare = currentRouteDist * BASE_RATE_PER_KM;

  // Split the base fare equally among all passengers in the pool
  const passengerSplit = baseFare / passengersInPool;

  // Flat charge per bag
  const luggageSurcharge = luggageCount * LUGGAGE_RATE;

  // How much longer is this passenger's actual route vs their direct route (%)
  // Percentage increase in route distance caused by pooling
  const detourPct = ((currentRouteDist - directDist) / directDist) * 100;

  // Penalty for accepting a detour — discourages gaming with huge detour tolerance
  const detourSurcharge = detourPct * DETOUR_PENALTY_RATE * baseFare;

  // Surge multiplier based on current demand
  const demandMultiplier = await getDemandMultiplier();

  const finalFare =
    (passengerSplit + luggageSurcharge + detourSurcharge) * demandMultiplier;

  // Round to 2 decimal places
  return Math.round(finalFare * 100) / 100;
}
