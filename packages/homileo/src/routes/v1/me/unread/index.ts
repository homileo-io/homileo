import { getUnread } from "./controllers.js";
import { Router } from "express";

const unreadRouter = Router();

unreadRouter.get("/", getUnread);

export default unreadRouter;
