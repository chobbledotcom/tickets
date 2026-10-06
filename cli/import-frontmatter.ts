#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-run

/** Import a markdown frontmatter catalog into a Tickets site.
 *
 *  One Tickets listing per product file in the catalog's src/products
 *  directory, with the product's filter attributes as site Attributes and
 *  its categories as groups. The listing ids and slugs are written back into
 *  the product files' frontmatter (tickets_id, tickets_slug), so the future
 *  integration can address them.
 *
 *  Reruns are safe: products whose frontmatter already carries a tickets_id
 *  are skipped, and attributes, options, and groups are matched by name before
 *  anything is created. A product whose title matches an existing listing is
 *  skipped until --update says otherwise. Use --plan to print what would
 *  happen and change nothing.
 *
 *  deno task cli:import-frontmatter [--plan] [--update] --dir <catalog>
 */

import { loadConfig } from "./config.ts";
import { type CurlOptions, curlJson } from "./curl.ts";
import { runImport } from "./import-run.ts";
import { writeErr } from "./io.ts";
import { parseImportFlags } from "./product-plan.ts";

const usage =
  "Usage: deno task cli:import-frontmatter [--plan] [--update] --dir <catalog directory>\n";

const main = async (): Promise<void> => {
  const flags = parseImportFlags(Deno.args);
  const dir = flags.dir;
  if (dir === undefined) {
    await writeErr(usage);
    Deno.exit(2);
  }
  const config = await loadConfig(Deno.cwd());
  await runImport({ ...flags, dir }, <T>(options: CurlOptions) =>
    curlJson<T>(config, options),
  );
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    await writeErr(
      `frontmatter import failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    Deno.exit(1);
  }
}
