import { removeParticipant, putParticipant } from "./controllers.js";
import { Router } from "express";

const participantRouter = Router({ mergeParams: true });

participantRouter.put("/", putParticipant);
participantRouter.delete("/", removeParticipant);

export default participantRouter;
