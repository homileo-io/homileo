import joinRequestRouter from "./join-request/index.js";
import { listJoinRequests } from "./controllers.js";
import { Router } from "express";

const joinRequestsRouter = Router({ mergeParams: true });

joinRequestsRouter.use("/:principalId", joinRequestRouter);

joinRequestsRouter.get("/", listJoinRequests);

export default joinRequestsRouter;
