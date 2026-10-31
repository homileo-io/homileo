import { listMessages, sendMessage } from "./controllers.js";
import { Router } from "express";

const messagesRouter = Router({ mergeParams: true });

messagesRouter.get("/", listMessages);
messagesRouter.post("/", sendMessage);

export default messagesRouter;
