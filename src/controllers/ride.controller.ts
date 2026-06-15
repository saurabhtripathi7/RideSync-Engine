import { Request, Response } from "express";

import { createRide, getRides, getRideById } from "../services/ride.service.js";

export async function createRideHandler(req: Request, res: Response) {
  try {
    const {
      passengerId,
      dropoffLat,
      dropoffLng,
      seatsNeeded,
      luggageCount,
      maxDetourPct,
      directDist,
    } = req.body;

    const ride = await createRide(
      passengerId,
      dropoffLat,
      dropoffLng,
      seatsNeeded,
      luggageCount,
      maxDetourPct,
      directDist,
    );

    res.status(201).json(ride);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to create ride",
    });
  }
}

export async function getRidesHandler(req: Request, res: Response) {
  const rides = await getRides();

  res.json(rides);
}

export async function getRideByIdHandler(req: Request, res: Response) {
  const ride = await getRideById(req.params.id as string);

  if (!ride) {
    return res.status(404).json({
      message: "Ride not found",
    });
  }

  res.json(ride);
}
