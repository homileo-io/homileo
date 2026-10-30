import { getSession, updateSession } from "./controllers.js";
import participantsRouter from "./participants/index.js";
import archiveRouter from "./archive/index.js";
import notifyRouter from "./notify/index.js";
import readRouter from "./read/index.js";
import { Router } from "express";

const sessionRouter = Router({ mergeParams: true });

sessionRouter.use("/archive", archiveRouter);
sessionRouter.use("/participants", participantsRouter);
sessionRouter.use("/read", readRouter);
sessionRouter.use("/notify", notifyRouter);

sessionRouter.get("/", getSession);
sessionRouter.patch("/", updateSession);

export default sessionRouter;
