import { Router } from "express";
import {
  createCabHandler,
  getCabsHandler,
} from "../controllers/cab.controller.js";

const router = Router();

router.post("/", createCabHandler);
router.get("/", getCabsHandler);

export default router;