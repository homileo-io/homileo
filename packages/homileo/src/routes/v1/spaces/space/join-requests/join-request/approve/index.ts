import { approveJoinRequest } from "./controllers.js";
import { Router } from "express";

const approveRouter = Router({ mergeParams: true });

approveRouter.post("/", approveJoinRequest);

export default approveRouter;
