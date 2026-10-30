import principalRouter from "./principal/index.js";
import resolveRouter from "./resolve/index.js";
import { Router } from "express";

const principalsRouter = Router();

principalsRouter.use("/resolve", resolveRouter);
principalsRouter.use("/:principalId", principalRouter);

export default principalsRouter;
