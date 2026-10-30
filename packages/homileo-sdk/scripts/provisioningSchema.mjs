import { URL } from "url";
import { provisioningJsonSchema } from "../dist/index.js";
import { writeFileSync } from "fs";

writeFileSync(
  new URL("../provisioning.schema.json", import.meta.url),
  `${JSON.stringify(provisioningJsonSchema, null, 2)}\n`
);
