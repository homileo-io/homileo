import { searchPrincipals } from "./controllers.js";
import { Router } from "express";

const principalsRouter = Router();

principalsRouter.get("/", searchPrincipals);

export default principalsRouter;
