import { Router } from "express";

import {
  createRideHandler,
  getRidesHandler,
  getRideByIdHandler,
} from "../controllers/ride.controller.js";

const router = Router();

router.post("/", createRideHandler);

router.get("/", getRidesHandler);

router.get("/:id", getRideByIdHandler);

export default router;
