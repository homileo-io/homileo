import { listMembers } from "./controllers.js";
import memberRouter from "./member/index.js";
import { Router } from "express";

const membersRouter = Router({ mergeParams: true });

membersRouter.use("/:principalId", memberRouter);

membersRouter.get("/", listMembers);

export default membersRouter;
