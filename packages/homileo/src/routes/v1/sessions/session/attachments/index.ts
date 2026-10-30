import { createAttachment } from "./controllers.js";
import { Router } from "express";

const attachmentsRouter = Router({ mergeParams: true });

attachmentsRouter.post("/", createAttachment);

export default attachmentsRouter;
