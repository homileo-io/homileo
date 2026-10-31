import { createDirect } from "./controllers.js";
import { Router } from "express";

const directRouter = Router();

directRouter.post("/", createDirect);

export default directRouter;
