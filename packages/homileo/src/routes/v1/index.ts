import { authenticate } from "../../middleware/auth.js";
import meRouter from "./me/index.js";
import { Router } from "express";

const v1Router = Router();

v1Router.use(authenticate);
v1Router.use("/me", meRouter);

export default v1Router;
