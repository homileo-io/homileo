import { authenticate } from "../../middleware/auth.js";
import principalsRouter from "./principals/index.js";
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

export default v1Router;
