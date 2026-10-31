import reactionRouter from "./reaction/index.js";
import { Router } from "express";

const reactionsRouter = Router({ mergeParams: true });

reactionsRouter.use("/:emoji", reactionRouter);

export default reactionsRouter;
