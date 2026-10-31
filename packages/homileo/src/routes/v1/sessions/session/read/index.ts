import { putRead } from "./controllers.js";
import { Router } from "express";

const readRouter = Router({ mergeParams: true });

readRouter.put("/", putRead);

export default readRouter;
