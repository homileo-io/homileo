import { requireChatWrite } from "../../../../../middleware/auth.js";
import { archiveSpace } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

archiveRouter.post("/", requireChatWrite, archiveSpace);

export default archiveRouter;
