import { Request, Response } from "express";

import {
  createPassenger,
  getPassengers,
  getPassengerById,
} from "../services/passenger.service.js";

export async function createPassengerHandler(req: Request, res: Response) {
  try {
    const { name, phone } = req.body;

    const passenger = await createPassenger(name, phone);

    res.status(201).json(passenger);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create passenger",
    });
  }
}

export async function getPassengersHandler(req: Request, res: Response) {
  const passengers = await getPassengers();

  res.json(passengers);
}

export async function getPassengerByIdHandler(req: Request, res: Response) {
  const passenger = await getPassengerById(req.params.id as string);

  if (!passenger) {
    res.status(404).json({
      message: "Passenger not found",
    });
    return;
  }

  res.json(passenger);
}
