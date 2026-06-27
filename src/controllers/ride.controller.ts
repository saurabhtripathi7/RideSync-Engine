import { Request, Response } from "express";
import { createRide, getRides, getRideById, getRideStatus } from "../services/ride.service.js";
import { publishRideRequested } from "../queues/ride.publisher.js";

export async function requestRideHandler(req: Request, res: Response) {
  try {
    const { passengerId, dropoffLat, dropoffLng, seatsNeeded, luggageCount, maxDetourPct } = req.body;

    if (!passengerId || dropoffLat == null || dropoffLng == null ||
        seatsNeeded == null || luggageCount == null || maxDetourPct == null) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const ride = await createRide(passengerId, dropoffLat, dropoffLng, seatsNeeded, luggageCount, maxDetourPct);

    // Publish to queue — worker handles matching asynchronously
    // We respond immediately without waiting for matching to complete
    publishRideRequested({ rideId: ride.id });

    res.status(202).json({ rideId: ride.id, status: ride.status });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: error.message || "Failed to create ride" });
  }
}

export async function getRidesHandler(req: Request, res: Response) {
  const rides = await getRides();
  res.json(rides);
}

export async function getRideByIdHandler(req: Request, res: Response) {
  const ride = await getRideById(req.params.id as string);

  if (!ride) {
    res.status(404).json({ message: "Ride not found" });
    return;
  }

  res.json(ride);
}

export async function getRideStatusHandler(req: Request, res: Response) {
  try {
    const status = await getRideStatus(req.params.id as string);
    res.status(200).json(status);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
}