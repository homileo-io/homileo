import { requireChatWrite } from "../../../../../middleware/auth.js";
import { joinSpace } from "./controllers.js";
import { Router } from "express";

const joinRouter = Router({ mergeParams: true });

joinRouter.post("/", requireChatWrite, joinSpace);

export default joinRouter;
