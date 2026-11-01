import { sync } from "./controllers.js";
import { Router } from "express";

const syncRouter = Router();

syncRouter.get("/", sync);

export default syncRouter;
