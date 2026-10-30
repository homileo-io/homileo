import { IdSchema } from "../../../../utils/idSchema.js";
import { SpaceFieldsShape } from "../schemas.js";
import { z } from "zod";

export const SpaceParamsSchema = z.object({ spaceId: IdSchema });

export const UpdateSpaceSchema = z
  .strictObject({
    name: SpaceFieldsShape.name.optional(),
    description: SpaceFieldsShape.description.optional(),
    visibility: SpaceFieldsShape.visibility.optional(),
    joinPolicy: SpaceFieldsShape.joinPolicy.optional(),
    postPolicy: SpaceFieldsShape.postPolicy.optional(),
    state: SpaceFieldsShape.state.optional(),
    externalRef: SpaceFieldsShape.externalRef.optional(),
    metadata: SpaceFieldsShape.metadata.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "Give at least one field to change",
  });
export type UpdateSpaceBody = z.infer<typeof UpdateSpaceSchema>;
