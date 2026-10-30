import { putMember, removeMember } from "./controllers.js";
import { Router } from "express";

const memberRouter = Router({ mergeParams: true });

memberRouter.put("/", putMember);
memberRouter.delete("/", removeMember);

export default memberRouter;
