import { requireChatWrite } from "../../../../../../../middleware/auth.js";
import { approveJoinRequest } from "./controllers.js";
import { Router } from "express";

const approveRouter = Router({ mergeParams: true });

approveRouter.post("/", requireChatWrite, approveJoinRequest);

export default approveRouter;
