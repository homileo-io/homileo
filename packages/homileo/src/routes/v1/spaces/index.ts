import { requirePermission } from "../../../middleware/auth.js";
import { createSpace, listSpaces } from "./controllers.js";
import spaceRouter from "./space/index.js";
import { Router } from "express";

const spacesRouter = Router();

spacesRouter.use("/:spaceId", spaceRouter);

spacesRouter.get("/", listSpaces);
spacesRouter.post("/", requirePermission("homileo.spaces.write"), createSpace);

export default spacesRouter;
