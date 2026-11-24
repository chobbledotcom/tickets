/** Compare every committed guide baseline with the Cucumber evidence run and
 * produce the freshness report. A stale guide is advisory: the caller decides
 * whether to refresh it now or leave it for another branch. */

import { join } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import type { EvidenceManifest } from "#scripts/specs/evidence/schema.ts";
import {
  type GuideFreshnessBaseline,
  parseGuideFreshnessBaseline,
} from "./baseline.ts";
import {
  EVIDENCE_MANIFEST,
  evidenceFingerprints,
  readEvidenceManifest,
} from "./evidence.ts";
import {
  buildFreshnessReport,
  type FreshnessReport,
  type GuideFreshness,
  gradeGuide,
} from "./freshness.ts";
import { storyboardEvidence } from "./storyboard.ts";
import { guideStoryboard } from "./storyboards/index.ts";

const GUIDES = join(projectRoot, "guides");

const readBaseline = async (slug: string): Promise<GuideFreshnessBaseline> =>
  parseGuideFreshnessBaseline(
    JSON.parse(await Deno.readTextFile(join(GUIDES, slug, "freshness.json"))),
  );

const baselineSlugs = async (): Promise<string[]> => {
  const slugs: string[] = [];
  for await (const entry of Deno.readDir(GUIDES)) {
    if (!entry.isDirectory) continue;
    try {
      await Deno.stat(join(GUIDES, entry.name, "freshness.json"));
      slugs.push(entry.name);
    } catch (error) {
      rethrowUnlessNotFound(error);
    }
  }
  return slugs.sort();
};

/** The slugs to check: the one asked for, or every guide with a baseline. */
const slugsToCheck = async (guide?: string): Promise<string[]> =>
  guide ? [guide] : await baselineSlugs();

const readManifest = async (): Promise<EvidenceManifest> => {
  try {
    return await readEvidenceManifest(EVIDENCE_MANIFEST);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `No evidence manifest at ${EVIDENCE_MANIFEST}. Run deno task specs:evidence first.`,
        { cause: error },
      );
    }
    throw error;
  }
};

const gradeOne = async (
  manifest: EvidenceManifest,
  slug: string,
): Promise<GuideFreshness> => {
  const storyboard = guideStoryboard(slug);
  const evidence = storyboardEvidence(storyboard);
  const [baseline, current] = await Promise.all([
    readBaseline(slug),
    evidenceFingerprints(manifest, EVIDENCE_MANIFEST, evidence),
  ]);
  return gradeGuide(
    { evidence, slug, title: storyboard.title },
    baseline,
    current,
  );
};

export const checkGuides = async (
  guide?: string,
): Promise<FreshnessReport | null> => {
  const slugs = await slugsToCheck(guide);
  if (slugs.length === 0) return null;
  const manifest = await readManifest();
  return buildFreshnessReport(
    await Promise.all(slugs.map((slug) => gradeOne(manifest, slug))),
  );
};
