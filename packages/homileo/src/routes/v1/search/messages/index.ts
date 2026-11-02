import { searchMessages } from "./controllers.js";
import { Router } from "express";

const messagesRouter = Router();

messagesRouter.get("/", searchMessages);

export default messagesRouter;
