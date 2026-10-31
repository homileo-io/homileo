import { resolvePrincipals } from "./controllers.js";
import { Router } from "express";

const resolveRouter = Router();

resolveRouter.post("/", resolvePrincipals);

export default resolveRouter;
