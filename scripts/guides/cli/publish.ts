#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { guideVideoBytes } from "#scripts/guides/build.ts";
import {
  EVIDENCE_MANIFEST,
  evidenceFingerprints,
  readEvidenceManifest,
} from "#scripts/guides/evidence.ts";
import {
  type GuideAnchors,
  publishVideos,
} from "#scripts/guides/publish-videos.ts";
import {
  parseGuideStoryboard,
  storyboardEvidence,
} from "#scripts/guides/storyboard.ts";
import {
  GUIDE_SLUGS,
  guideStoryboard,
} from "#scripts/guides/storyboards/index.ts";
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

/** The evidence screenshot hashes for each guide, keyed by capture id. A build
 * that has not run the evidence capture cannot tell whether the footage is
 * current, so the lookup fails loudly rather than re-rendering blind. */
const anchorsFromEvidence = async (
  slugs: readonly string[],
): Promise<GuideAnchors> => {
  const manifest = await readEvidenceManifest(EVIDENCE_MANIFEST);
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      const storyboard = parseGuideStoryboard(guideStoryboard(slug));
      const evidence = storyboardEvidence(storyboard);
      const anchors = await evidenceFingerprints(
        manifest,
        EVIDENCE_MANIFEST,
        evidence,
      );
      return [slug, anchors] as const;
    }),
  );
  return Object.fromEntries(entries);
};

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
  const slugs = options.slug === undefined ? GUIDE_SLUGS : [options.slug];
  const anchors = await anchorsFromEvidence(slugs);
  const render = (slug: string): Promise<Uint8Array> =>
    guideVideoBytes({ fromSession: options.from, slug });
  const published = await publishVideos(config, {
    anchors,
    fetcher: fetch,
    render,
    slug: options.slug,
  });
  console.log(
    `Published guide video(s) ${published.slugs.join(", ")}:\n${JSON.stringify(published.videos, null, 2)}`,
  );
  await writeGithubOutput(published.videos);
}
