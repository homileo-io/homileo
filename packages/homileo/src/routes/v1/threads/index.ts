import threadRouter from "./thread/index.js";
import { Router } from "express";

const threadsRouter = Router();

threadsRouter.use("/:rootId", threadRouter);

export default threadsRouter;
