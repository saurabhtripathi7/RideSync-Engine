  import { Router } from "express";

  import {
    createPassengerHandler,
    getPassengersHandler,
    getPassengerByIdHandler,
  } from "../controllers/passenger.controller.js";

  const router = Router();

  router.post("/", createPassengerHandler);

  router.get("/", getPassengersHandler);

  router.get("/:id", getPassengerByIdHandler);

  export default router;
