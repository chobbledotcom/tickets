/**
 * The bridge between a guide and the Cucumber evidence run. A guide names a
 * capture; this finds the PNG the evidence run wrote for it and fingerprints
 * it at the time the video is built.
 */

import { dirname, join } from "@std/path";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import type { ScreenshotProfileName } from "#scripts/screenshots/profile.ts";
import {
  type EvidenceManifest,
  EvidenceManifestSchema,
} from "#scripts/specs/evidence/schema.ts";
import { fingerprintPng, type GuideFingerprint } from "./fingerprint.ts";

export const EVIDENCE_MANIFEST = join(
  projectRoot,
  "reports",
  "evidence",
  "manifest.json",
);

export const readEvidenceManifest = async (
  path: string,
): Promise<EvidenceManifest> =>
  v.parse(EvidenceManifestSchema, JSON.parse(await Deno.readTextFile(path)));

const captureNamed = (
  manifest: EvidenceManifest,
  manifestPath: string,
  captureId: string,
) => {
  const capture = manifest.captures.find(({ id }) => id === captureId);
  if (!capture) {
    throw new Error(`No evidence capture ${captureId} in ${manifestPath}`);
  }
  return capture;
};

export const evidenceAssetBytes = async (
  manifest: EvidenceManifest,
  manifestPath: string,
  captureId: string,
  profile: ScreenshotProfileName,
): Promise<Uint8Array> => {
  const capture = captureNamed(manifest, manifestPath, captureId);
  const asset = capture.assets.find(
    (candidate) => candidate.profile === profile,
  );
  if (!asset) {
    throw new Error(
      `Evidence capture ${captureId} has no ${profile} asset in ${manifestPath}`,
    );
  }
  try {
    return await Deno.readFile(join(dirname(manifestPath), asset.path));
  } catch (error) {
    throw new Error(
      `Cannot read the ${profile} asset for ${captureId} at ${join(dirname(manifestPath), asset.path)}`,
      { cause: error },
    );
  }
};

export const evidenceFingerprints = async (
  manifest: EvidenceManifest,
  manifestPath: string,
  captures: readonly { captureId: string; caseId: string }[],
  profile: ScreenshotProfileName,
): Promise<Record<string, GuideFingerprint>> => {
  const entries = await Promise.all(
    captures.map(async ({ captureId, caseId }) => {
      const capture = captureNamed(manifest, manifestPath, captureId);
      if (capture.case.id !== caseId) {
        throw new Error(
          `Evidence capture ${captureId} belongs to ${capture.case.id}, not ${caseId}`,
        );
      }
      const bytes = await evidenceAssetBytes(
        manifest,
        manifestPath,
        captureId,
        profile,
      );
      return [captureId, await fingerprintPng(bytes)] as const;
    }),
  );
  return Object.fromEntries(entries);
};
