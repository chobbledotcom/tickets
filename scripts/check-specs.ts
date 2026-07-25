#!/usr/bin/env -S deno run --allow-read
import { readSpecCatalog } from "./specs/catalog.ts";

if (import.meta.main) {
  const catalog = await readSpecCatalog();
  const rules = catalog.stories.reduce(
    (count, story) => count + story.rules.length,
    0,
  );
  console.log(
    `Validated ${catalog.stories.length} Cucumber story and ${rules} rules.`,
  );
}
