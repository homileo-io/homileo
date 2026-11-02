import { requireChatWrite } from "../../../../../../../middleware/auth.js";
import { denyJoinRequest } from "./controllers.js";
import { Router } from "express";

const denyRouter = Router({ mergeParams: true });

denyRouter.post("/", requireChatWrite, denyJoinRequest);

export default denyRouter;
