/** Compare every committed guide baseline with the Cucumber evidence run and
 * produce the freshness report. A stale guide is advisory: the caller decides
 * whether to refresh it now or leave it for another branch. */

import { join } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import type { EvidenceManifest } from "#scripts/specs/evidence/schema.ts";
import { requireValue } from "#shared/required-value.ts";
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
  gradeGuide,
} from "./freshness.ts";

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

export const readGuideBaselines = async (
  guide?: string,
): Promise<GuideFreshnessBaseline[]> => {
  if (guide) return [await readBaseline(guide)];
  const slugs = await baselineSlugs();
  return await Promise.all(slugs.map(readBaseline));
};

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

export const checkGuides = async (
  guide?: string,
): Promise<FreshnessReport | null> => {
  const baselines = await readGuideBaselines(guide);
  if (baselines.length === 0) return null;
  const manifest = await readManifest();
  const current = await Promise.all(
    baselines.map((baseline) =>
      evidenceFingerprints(
        manifest,
        EVIDENCE_MANIFEST,
        baseline.anchors,
        baseline.profile,
      ),
    ),
  );
  return buildFreshnessReport(
    baselines.map((baseline, index) =>
      gradeGuide(
        baseline,
        requireValue(current[index], "Missing fingerprints"),
      ),
    ),
  );
};
