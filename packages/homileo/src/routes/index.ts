import healthRouter from "./health/index.js";
import v1Router from "./v1/index.js";
import { Router } from "express";

/** Homileo's URL tree: the API is versioned under /v1, /health stays at the root. */
const router = Router();

router.use("/health", healthRouter);
router.use("/v1", v1Router);

export default router;
