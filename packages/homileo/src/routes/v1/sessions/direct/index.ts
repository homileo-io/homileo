import { requireChatWrite } from "../../../../middleware/auth.js";
import { createDirect } from "./controllers.js";
import { Router } from "express";

const directRouter = Router();

directRouter.post("/", requireChatWrite, createDirect);

export default directRouter;
