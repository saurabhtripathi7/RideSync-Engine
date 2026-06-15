import { Request, Response } from "express";

import {
  createDriver,
  getDrivers,
  getDriverById,
} from "../services/driver.service.js";

export async function createDriverHandler(req: Request, res: Response) {
  try {
    const { name, phone, cabId } = req.body;

    const driver = await createDriver(name, phone, cabId);

    res.status(201).json(driver);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to create driver",
    });
  }
}

export async function getDriversHandler(req: Request, res: Response) {
  const drivers = await getDrivers();

  res.json(drivers);
}

export async function getDriverByIdHandler(req: Request, res: Response) {
  const driver = await getDriverById(req.params.id as string);

  if (!driver) {
    return res.status(404).json({
      message: "Driver not found",
    });
  }

  res.json(driver);
}
