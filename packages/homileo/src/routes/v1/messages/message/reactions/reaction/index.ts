import { requireChatWrite } from "../../../../../../middleware/auth.js";
import { addReaction, removeReaction } from "./controllers.js";
import { Router } from "express";

const reactionRouter = Router({ mergeParams: true });

reactionRouter.put("/", requireChatWrite, addReaction);
reactionRouter.delete("/", requireChatWrite, removeReaction);

export default reactionRouter;
