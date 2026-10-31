import { listRevisions } from "./controllers.js";
import { Router } from "express";

const revisionsRouter = Router({ mergeParams: true });

revisionsRouter.get("/", listRevisions);

export default revisionsRouter;
