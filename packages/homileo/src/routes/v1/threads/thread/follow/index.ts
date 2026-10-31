import { putFollow } from "./controllers.js";
import { Router } from "express";

const followRouter = Router({ mergeParams: true });

followRouter.put("/", putFollow);

export default followRouter;
