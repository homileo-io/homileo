import { requireChatWrite } from "../../../../../middleware/auth.js";
import { archiveSession } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

archiveRouter.post("/", requireChatWrite, archiveSession);

export default archiveRouter;
