import joinRequestsRouter from "./join-requests/index.js";
import { getSpace, updateSpace } from "./controllers.js";
import archiveRouter from "./archive/index.js";
import membersRouter from "./members/index.js";
import joinRouter from "./join/index.js";
import { Router } from "express";

const spaceRouter = Router({ mergeParams: true });

spaceRouter.use("/archive", archiveRouter);
spaceRouter.use("/members", membersRouter);
spaceRouter.use("/join", joinRouter);
spaceRouter.use("/join-requests", joinRequestsRouter);

spaceRouter.get("/", getSpace);
spaceRouter.patch("/", updateSpace);

export default spaceRouter;
