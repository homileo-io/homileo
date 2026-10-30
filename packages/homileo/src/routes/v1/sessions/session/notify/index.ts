import { putNotify } from "./controllers.js";
import { Router } from "express";

const notifyRouter = Router({ mergeParams: true });

notifyRouter.put("/", putNotify);

export default notifyRouter;
