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

import type { AdminApiTransport } from "#shared/admin-api-client.ts";
import { loadConfig } from "./config.ts";
import { curlTransport } from "./curl.ts";
import { CliError, toErrorResult } from "./errors.ts";
import { runImport } from "./import-run.ts";
import { writeErr } from "./io.ts";
import { parseImportFlags } from "./product-plan.ts";

const usage =
  "Usage: deno task cli:import-frontmatter [--plan] [--update] --dir <catalog directory>";

const main = async (): Promise<number> => {
  const flags = parseImportFlags(Deno.args);
  const dir = flags.dir;
  if (dir === undefined) {
    throw new CliError(
      "usage",
      `The import needs the catalog directory. ${usage}`,
    );
  }
  const config = await loadConfig(Deno.cwd());
  const transport: AdminApiTransport = curlTransport(config);
  await runImport({ ...flags, dir }, transport);
  return 0;
};

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    // A failure the client did not name is the import's own input or its
    // environment: the message carries the cause, and the exit code stays 6.
    const { code, err } = toErrorResult(error, "io");
    await writeErr(err);
    Deno.exit(code);
  }
}
