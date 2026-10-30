import { createSession, listSessions } from "./controllers.js";
import sessionRouter from "./session/index.js";
import directRouter from "./direct/index.js";
import { Router } from "express";

const sessionsRouter = Router();

sessionsRouter.use("/direct", directRouter);
sessionsRouter.use("/:sessionId", sessionRouter);

sessionsRouter.get("/", listSessions);
sessionsRouter.post("/", createSession);

export default sessionsRouter;
