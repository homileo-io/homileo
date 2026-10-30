import { authenticate } from "../../middleware/auth.js";
import principalsRouter from "./principals/index.js";
import meRouter from "./me/index.js";
import { Router } from "express";

const v1Router = Router();

v1Router.use(authenticate);
v1Router.use("/me", meRouter);
v1Router.use("/principals", principalsRouter);

export default v1Router;
