import { requireChatWrite } from "../../../../../middleware/auth.js";
import { createAttachment } from "./controllers.js";
import { Router } from "express";

const attachmentsRouter = Router({ mergeParams: true });

attachmentsRouter.post("/", requireChatWrite, createAttachment);

export default attachmentsRouter;
