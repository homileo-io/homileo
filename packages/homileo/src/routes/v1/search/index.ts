import messagesRouter from "./messages/index.js";
import sessionsRouter from "./sessions/index.js";
import { Router } from "express";

const searchRouter = Router();

searchRouter.use("/messages", messagesRouter);
searchRouter.use("/sessions", sessionsRouter);

export default searchRouter;
