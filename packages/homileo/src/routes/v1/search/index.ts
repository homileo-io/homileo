import messagesRouter from "./messages/index.js";
import { Router } from "express";

const searchRouter = Router();

searchRouter.use("/messages", messagesRouter);

export default searchRouter;
