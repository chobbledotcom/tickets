#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { publishGuideVideos } from "#scripts/guides/publish.ts";
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

/** The workflow reads one JSON object naming the video for each guide. An
 * empty object means no guide links render, which is what a build without CDN
 * secrets must do: the MP4s could not be served from the edge script. */
const writeGithubOutput = async (
  videos: Record<string, { video: string }>,
): Promise<void> => {
  const githubOutput = Deno.env.get("GITHUB_OUTPUT");
  if (githubOutput === undefined) return;
  await Deno.writeTextFile(
    githubOutput,
    `guide_videos=${JSON.stringify(videos)}\n`,
    { append: true },
  );
};

const config = loadStaticCdnConfig(Deno.env.toObject());
if (config === null) {
  console.log(
    "No Bunny CDN storage secrets: skipping the guide videos. The app hides their links.",
  );
  await writeGithubOutput({});
} else {
  const published = await publishGuideVideos(config, {
    ...(options.from === undefined ? {} : { fromSession: options.from }),
    ...(options.slug === undefined ? {} : { slug: options.slug }),
  });
  console.log(
    `Published guide video(s) ${published.slugs.join(", ")}:\n${JSON.stringify(published.videos, null, 2)}`,
  );
  await writeGithubOutput(published.videos);
}
