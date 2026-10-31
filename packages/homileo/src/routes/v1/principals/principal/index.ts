import { getPrincipal } from "./controllers.js";
import { Router } from "express";

const principalRouter = Router({ mergeParams: true });

principalRouter.get("/", getPrincipal);

export default principalRouter;
