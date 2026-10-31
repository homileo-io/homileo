import { listMentions } from "./controllers.js";
import { Router } from "express";

const mentionsRouter = Router();

mentionsRouter.get("/", listMentions);

export default mentionsRouter;
