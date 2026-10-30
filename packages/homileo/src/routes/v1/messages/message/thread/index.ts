import { getThread } from "./controllers.js";
import { Router } from "express";

const threadRouter = Router({ mergeParams: true });

threadRouter.get("/", getThread);

export default threadRouter;
