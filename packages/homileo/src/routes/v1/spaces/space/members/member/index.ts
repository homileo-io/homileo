import { requireChatWrite } from "../../../../../../middleware/auth.js";
import { putMember, removeMember } from "./controllers.js";
import { Router } from "express";

const memberRouter = Router({ mergeParams: true });

memberRouter.put("/", requireChatWrite, putMember);
memberRouter.delete("/", requireChatWrite, removeMember);

export default memberRouter;
