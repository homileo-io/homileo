import { archiveSpace } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

archiveRouter.post("/", archiveSpace);

export default archiveRouter;
