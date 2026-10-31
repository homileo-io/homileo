import approveRouter from "./approve/index.js";
import denyRouter from "./deny/index.js";
import { Router } from "express";

const joinRequestRouter = Router({ mergeParams: true });

joinRequestRouter.use("/approve", approveRouter);
joinRequestRouter.use("/deny", denyRouter);

export default joinRequestRouter;
