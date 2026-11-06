/**
 * Write the message group list from the catalog files.
 *
 * Usage: deno task locales:generate
 */

import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";
import { MESSAGE_GROUPS_FILE, messageGroupsSource } from "./render.ts";

const fileNames = Array.from(
  Deno.readDirSync(join(projectRoot, "src/locales/en")),
  (entry) => entry.name,
);

await Deno.writeTextFile(
  join(projectRoot, MESSAGE_GROUPS_FILE),
  messageGroupsSource(fileNames),
);
console.log(`Wrote ${MESSAGE_GROUPS_FILE}.`);
