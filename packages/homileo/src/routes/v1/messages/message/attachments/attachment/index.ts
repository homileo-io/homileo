import { getAttachment } from "./controllers.js";
import { Router } from "express";

const attachmentRouter = Router({ mergeParams: true });

attachmentRouter.get("/", getAttachment);

export default attachmentRouter;
