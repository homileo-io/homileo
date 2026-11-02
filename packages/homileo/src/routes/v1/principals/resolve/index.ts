import { requireChatWrite } from "../../../../middleware/auth.js";
import { resolvePrincipals } from "./controllers.js";
import { Router } from "express";

const resolveRouter = Router();

resolveRouter.post("/", requireChatWrite, resolvePrincipals);

export default resolveRouter;
