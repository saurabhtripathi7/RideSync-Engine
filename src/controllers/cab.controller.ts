import type { Request, Response } from "express";
import { createCab, getCabs } from "../services/cab.service.js";
import { CabType } from "../db/prisma-client/enums.js";

export async function createCabHandler(req: Request, res: Response) {
  try {
    const { plateNumber, totalSeats, luggageCapacity, cabType } = req.body;

    const cab = await createCab(
      plateNumber,
      totalSeats,
      luggageCapacity,
      cabType as CabType,
    );

    res.status(201).json(cab);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to create cab",
    });
  }
}

export async function getCabsHandler(req: Request, res: Response) {
  const cabs = await getCabs();

  res.json(cabs);
}
