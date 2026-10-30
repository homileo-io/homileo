import { joinSpace } from "./controllers.js";
import { Router } from "express";

const joinRouter = Router({ mergeParams: true });

joinRouter.post("/", joinSpace);

export default joinRouter;
