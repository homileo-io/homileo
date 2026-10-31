import attachmentRouter from "./attachment/index.js";
import { Router } from "express";

const attachmentsRouter = Router({ mergeParams: true });

attachmentsRouter.use("/:attachmentId", attachmentRouter);

export default attachmentsRouter;
