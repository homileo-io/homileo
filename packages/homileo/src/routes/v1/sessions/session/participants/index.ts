import participantRouter from "./participant/index.js";
import { listParticipants } from "./controllers.js";
import { Router } from "express";

const participantsRouter = Router({ mergeParams: true });

participantsRouter.use("/:principalId", participantRouter);

participantsRouter.get("/", listParticipants);

export default participantsRouter;
