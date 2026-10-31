import messageRouter from "./message/index.js";
import { Router } from "express";

const messagesRouter = Router();

messagesRouter.use("/:messageId", messageRouter);

export default messagesRouter;
