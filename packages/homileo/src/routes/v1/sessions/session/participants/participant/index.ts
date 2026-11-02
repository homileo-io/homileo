import { removeParticipant, putParticipant } from "./controllers.js";
import { Router } from "express";
import {
  requireChatWrite,
  requireChatWriteUnlessSelf,
} from "../../../../../../middleware/auth.js";

const participantRouter = Router({ mergeParams: true });

participantRouter.put("/", requireChatWrite, putParticipant);
participantRouter.delete("/", requireChatWriteUnlessSelf, removeParticipant);

export default participantRouter;
