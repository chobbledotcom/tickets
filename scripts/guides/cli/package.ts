#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
/** Turn a recorded session into the WebP player package without uploading it.
 * Use `guide:record --keep-session` first, then `guide:serve` to view it. */
import { join } from "@std/path";
import { packageGuideAnimation } from "#scripts/guides/package.ts";
import { removeTree } from "#scripts/guides/remove-tree.ts";
import { bundleGuideRenderer } from "#scripts/guides/render/bundle.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { guideSlugs } from "./args.ts";

const REPORTS = join(projectRoot, "reports", "guides");
const options = parseArgs(Deno.args, { string: ["from", "out"] });
const slugs = guideSlugs(options._, ["create-a-listing"], options.from);

if (import.meta.main) {
  const out = options.out ?? join(REPORTS, "preview");
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(join(out, "player.js"), await bundleGuideRenderer());
  for (const slug of slugs) {
    const sessionDir = options.from ?? join(REPORTS, slug, "session");
    const guideDir = join(out, slug);
    await removeTree(guideDir);
    await packageGuideAnimation(sessionDir, guideDir);
    console.log(`Packaged ${slug}: ${join(guideDir, "index.html")}`);
  }
  console.log(`Player bundle: ${join(out, "player.js")}`);
}
