import { Router } from "express";
import {
  requestRideHandler,
  getRidesHandler,
  getRideByIdHandler,
  getRideStatusHandler,
} from "../controllers/ride.controller.js";

const router = Router();

router.post("/request", requestRideHandler);      // create + publish to queue
router.get("/", getRidesHandler);                 // list all (kept as-is)
router.get("/:id", getRideByIdHandler);           // full ride object (kept as-is)
router.get("/:id/status", getRideStatusHandler);  // lightweight status poll

export default router;