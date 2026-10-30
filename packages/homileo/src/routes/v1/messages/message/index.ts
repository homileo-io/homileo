import { deleteMessage, editMessage, getMessage } from "./controllers.js";
import reactionsRouter from "./reactions/index.js";
import revisionsRouter from "./revisions/index.js";
import { Router } from "express";

const messageRouter = Router({ mergeParams: true });

messageRouter.use("/reactions", reactionsRouter);
messageRouter.use("/revisions", revisionsRouter);

messageRouter.get("/", getMessage);
messageRouter.patch("/", editMessage);
messageRouter.delete("/", deleteMessage);

export default messageRouter;
