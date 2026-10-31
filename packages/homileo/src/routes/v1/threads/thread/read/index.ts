import { putThreadRead } from "./controllers.js";
import { Router } from "express";

const readRouter = Router({ mergeParams: true });

readRouter.put("/", putThreadRead);

export default readRouter;
