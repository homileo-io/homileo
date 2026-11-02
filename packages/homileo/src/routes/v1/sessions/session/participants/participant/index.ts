import { requireChatWrite } from "../../../../../../middleware/auth.js";
import { removeParticipant, putParticipant } from "./controllers.js";
import { Router } from "express";

const participantRouter = Router({ mergeParams: true });

participantRouter.put("/", requireChatWrite, putParticipant);
participantRouter.delete("/", requireChatWrite, removeParticipant);

export default participantRouter;
