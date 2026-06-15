import { Router } from "express";
import {
  createCabHandler,
  getCabsHandler,
  getCabByIdHandler,
} from "../controllers/cab.controller.js";

const router = Router();

router.post("/", createCabHandler);
router.get("/", getCabsHandler);
router.get("/:id", getCabByIdHandler);

export default router;