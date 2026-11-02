import { deleteMessage, editMessage, getMessage } from "./controllers.js";
import { requireChatWrite } from "../../../../middleware/auth.js";
import attachmentsRouter from "./attachments/index.js";
import reactionsRouter from "./reactions/index.js";
import revisionsRouter from "./revisions/index.js";
import threadRouter from "./thread/index.js";
import { Router } from "express";

const messageRouter = Router({ mergeParams: true });

messageRouter.use("/reactions", reactionsRouter);
messageRouter.use("/attachments", attachmentsRouter);
messageRouter.use("/revisions", revisionsRouter);
messageRouter.use("/thread", threadRouter);

messageRouter.get("/", getMessage);
messageRouter.patch("/", requireChatWrite, editMessage);
messageRouter.delete("/", requireChatWrite, deleteMessage);

export default messageRouter;
