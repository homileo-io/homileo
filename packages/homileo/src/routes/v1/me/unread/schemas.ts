// The unread totals take no query; anything else is a client mistake.
import { z } from "zod";

export const UnreadQuerySchema = z.strictObject({});
