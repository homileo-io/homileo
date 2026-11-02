import { requireChatWrite } from "../../../../../middleware/auth.js";
import { listMessages, sendMessage } from "./controllers.js";
import { Router } from "express";

const messagesRouter = Router({ mergeParams: true });

messagesRouter.get("/", listMessages);
messagesRouter.post("/", requireChatWrite, sendMessage);

export default messagesRouter;
