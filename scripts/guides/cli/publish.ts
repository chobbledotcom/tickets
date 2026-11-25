#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { publishGuideAnimations } from "#scripts/guides/publish.ts";
import { GUIDE_SLUGS } from "#scripts/guides/storyboards/index.ts";
import { loadStaticCdnConfig } from "#scripts/static-cdn.ts";
import { requireOneGuide } from "./args.ts";

const options = parseArgs(Deno.args, {
  string: ["from", "slug"],
});
if (options.from !== undefined && options.slug === undefined) {
  throw new Error("--from needs --slug");
}
requireOneGuide(
  options.slug === undefined ? GUIDE_SLUGS : [options.slug],
  options.from,
);
const config = loadStaticCdnConfig(Deno.env.toObject());
if (config === null) {
  throw new Error(
    "CDN_URL, CDN_BUNNY_STORAGE_ZONE_NAME, CDN_BUNNY_STORAGE_ZONE_KEY, CDN_BUNNY_STORAGE_HOST, CDN_BUNNY_PULL_ZONE_ID, and BUNNY_ACCESS_KEY must be set",
  );
}

const published = await publishGuideAnimations(config, {
  ...(options.from === undefined ? {} : { fromSession: options.from }),
  ...(options.slug === undefined ? {} : { slug: options.slug }),
});
console.log(
  `Published guide animation(s) ${published.slugs.join(", ")} to ${published.baseUrl}`,
);
const githubOutput = Deno.env.get("GITHUB_OUTPUT");
if (githubOutput !== undefined) {
  await Deno.writeTextFile(githubOutput, `guide_base=${published.baseUrl}\n`, {
    append: true,
  });
}
