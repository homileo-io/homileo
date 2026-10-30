import { archiveSession } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

archiveRouter.post("/", archiveSession);

export default archiveRouter;
