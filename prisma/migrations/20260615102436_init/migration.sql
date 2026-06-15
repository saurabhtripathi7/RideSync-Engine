-- CreateEnum
CREATE TYPE "CabType" AS ENUM ('SEDAN', 'SUV', 'VAN');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'BUSY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "PoolStatus" AS ENUM ('FORMING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('SEARCHING', 'MATCHED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Passenger" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Passenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cab" (
    "id" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "luggageCapacity" INTEGER NOT NULL,
    "cabType" "CabType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'AVAILABLE',
    "cabId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL,
    "cabId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" "PoolStatus" NOT NULL DEFAULT 'FORMING',
    "totalSeatsUsed" INTEGER NOT NULL DEFAULT 0,
    "totalLuggageUsed" INTEGER NOT NULL DEFAULT 0,
    "routeOrder" TEXT NOT NULL DEFAULT '[]',
    "routeDropoffLats" TEXT NOT NULL DEFAULT '[]',
    "routeDropoffLngs" TEXT NOT NULL DEFAULT '[]',
    "totalRouteDist" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ride" (
    "id" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "poolId" TEXT,
    "dropoffLat" DOUBLE PRECISION NOT NULL,
    "dropoffLng" DOUBLE PRECISION NOT NULL,
    "seatsNeeded" INTEGER NOT NULL,
    "luggageCount" INTEGER NOT NULL,
    "maxDetourPct" DOUBLE PRECISION NOT NULL,
    "directDist" DOUBLE PRECISION NOT NULL,
    "currentRouteDist" DOUBLE PRECISION,
    "fare" DOUBLE PRECISION,
    "dropOrder" INTEGER,
    "status" "RideStatus" NOT NULL DEFAULT 'SEARCHING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Passenger_phone_key" ON "Passenger"("phone");

-- CreateIndex
CREATE INDEX "Passenger_phone_idx" ON "Passenger"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Cab_plateNumber_key" ON "Cab"("plateNumber");

-- CreateIndex
CREATE INDEX "Cab_plateNumber_idx" ON "Cab"("plateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_phone_key" ON "Driver"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_cabId_key" ON "Driver"("cabId");

-- CreateIndex
CREATE INDEX "Driver_status_idx" ON "Driver"("status");

-- CreateIndex
CREATE INDEX "Driver_phone_idx" ON "Driver"("phone");

-- CreateIndex
CREATE INDEX "Pool_status_createdAt_idx" ON "Pool"("status", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "Pool_driverId_idx" ON "Pool"("driverId");

-- CreateIndex
CREATE INDEX "Pool_cabId_idx" ON "Pool"("cabId");

-- CreateIndex
CREATE INDEX "Ride_poolId_idx" ON "Ride"("poolId");

-- CreateIndex
CREATE INDEX "Ride_passengerId_idx" ON "Ride"("passengerId");

-- CreateIndex
CREATE INDEX "Ride_status_idx" ON "Ride"("status");

-- CreateIndex
CREATE INDEX "Ride_createdAt_idx" ON "Ride"("createdAt");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_cabId_fkey" FOREIGN KEY ("cabId") REFERENCES "Cab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pool" ADD CONSTRAINT "Pool_cabId_fkey" FOREIGN KEY ("cabId") REFERENCES "Cab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pool" ADD CONSTRAINT "Pool_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
