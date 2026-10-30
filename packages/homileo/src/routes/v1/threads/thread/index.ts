import followRouter from "./follow/index.js";
import readRouter from "./read/index.js";
import { Router } from "express";

const threadRouter = Router({ mergeParams: true });

threadRouter.use("/read", readRouter);
threadRouter.use("/follow", followRouter);

export default threadRouter;
