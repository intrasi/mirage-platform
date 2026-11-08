import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { profileSchema } from "../shared/schema.js";
await writeFile(
  "docs/device-profile.schema.json",
  JSON.stringify(z.toJSONSchema(profileSchema), null, 2) + "\n",
);
