import { getMe } from "./controllers.js";
import { Router } from "express";

const meRouter = Router();

meRouter.get("/", getMe);

export default meRouter;
