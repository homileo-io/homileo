import { authenticate } from "../../middleware/auth.js";
import principalsRouter from "./principals/index.js";
import messagesRouter from "./messages/index.js";
import sessionsRouter from "./sessions/index.js";
import threadsRouter from "./threads/index.js";
import spacesRouter from "./spaces/index.js";
import express, { Router } from "express";
import meRouter from "./me/index.js";

const v1Router = Router();

// Each area sets its own JSON body limit; the parser runs after authentication.
const json64k = express.json({ limit: "64kb" });

v1Router.use(authenticate);
v1Router.use("/me", meRouter);
v1Router.use("/principals", json64k, principalsRouter);
v1Router.use("/spaces", json64k, spacesRouter);
v1Router.use("/sessions", express.json({ limit: "256kb" }), sessionsRouter);
v1Router.use("/messages", express.json({ limit: "256kb" }), messagesRouter);
v1Router.use("/threads", json64k, threadsRouter);

export default v1Router;
