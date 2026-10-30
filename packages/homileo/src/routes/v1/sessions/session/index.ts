import { getSession, updateSession } from "./controllers.js";
import archiveRouter from "./archive/index.js";
import { Router } from "express";

const sessionRouter = Router({ mergeParams: true });

sessionRouter.use("/archive", archiveRouter);

sessionRouter.get("/", getSession);
sessionRouter.patch("/", updateSession);

export default sessionRouter;
