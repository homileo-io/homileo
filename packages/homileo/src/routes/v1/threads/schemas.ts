import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

export const ThreadParamsSchema = z.object({ rootId: IdSchema });
