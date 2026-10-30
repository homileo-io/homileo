import healthRouter from "./health/index.js";
import { Router } from "express";

/** Homileo's URL tree: the API is versioned under /v1, /health stays at the root. */
const router = Router();

router.use("/health", healthRouter);
// Mounted by the plan's route tasks; the folder is written as they land.
// router.use("/v1", v1Router);

export default router;
