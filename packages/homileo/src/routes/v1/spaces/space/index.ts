import { getSpace, updateSpace } from "./controllers.js";
import archiveRouter from "./archive/index.js";
import { Router } from "express";

const spaceRouter = Router({ mergeParams: true });

spaceRouter.use("/archive", archiveRouter);

spaceRouter.get("/", getSpace);
spaceRouter.patch("/", updateSpace);

export default spaceRouter;
