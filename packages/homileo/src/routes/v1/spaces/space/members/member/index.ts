import { putMember, removeMember } from "./controllers.js";
import { Router } from "express";
import {
  requireChatWrite,
  requireChatWriteUnlessSelf,
} from "../../../../../../middleware/auth.js";

const memberRouter = Router({ mergeParams: true });

memberRouter.put("/", requireChatWrite, putMember);
memberRouter.delete("/", requireChatWriteUnlessSelf, removeMember);

export default memberRouter;
