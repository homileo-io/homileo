import mentionsRouter from "./mentions/index.js";
import unreadRouter from "./unread/index.js";
import { getMe } from "./controllers.js";
import { Router } from "express";

const meRouter = Router();

meRouter.use("/unread", unreadRouter);
meRouter.use("/mentions", mentionsRouter);
meRouter.get("/", getMe);

export default meRouter;
