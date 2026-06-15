import { Router } from "express";

import {
  createDriverHandler,
  getDriversHandler,
  getDriverByIdHandler,
} from "../controllers/driver.controller.js";

const router = Router();

router.post("/", createDriverHandler);

router.get("/", getDriversHandler);

router.get("/:id", getDriverByIdHandler);

export default router;