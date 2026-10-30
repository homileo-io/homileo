import { addReaction, removeReaction } from "./controllers.js";
import { Router } from "express";

const reactionRouter = Router({ mergeParams: true });

reactionRouter.put("/", addReaction);
reactionRouter.delete("/", removeReaction);

export default reactionRouter;
