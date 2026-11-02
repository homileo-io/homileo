import { searchSessions } from "./controllers.js";
import { Router } from "express";

const sessionsRouter = Router();

sessionsRouter.get("/", searchSessions);

export default sessionsRouter;
