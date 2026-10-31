import { denyJoinRequest } from "./controllers.js";
import { Router } from "express";

const denyRouter = Router({ mergeParams: true });

denyRouter.post("/", denyJoinRequest);

export default denyRouter;
