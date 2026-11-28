/**
 * Selects the evidence the guide videos use. The capture hook takes every
 * capture of a selected case, so this keeps all of them and the manifest
 * matches what the hook writes.
 */

import type { EvidenceCaptureDeclaration } from "#scripts/specs/evidence/schema.ts";
import { type GuideStoryboard, storyboardEvidence } from "./storyboard.ts";

export const guideEvidenceDeclarations = (
  declarations: readonly EvidenceCaptureDeclaration[],
  storyboards: readonly GuideStoryboard[],
): readonly EvidenceCaptureDeclaration[] => {
  const byId = new Map(
    declarations.map((declaration) => [declaration.id, declaration]),
  );
  const caseIds = new Set<string>();
  for (const storyboard of storyboards) {
    for (const { captureId, caseId } of storyboardEvidence(storyboard)) {
      const declaration = byId.get(captureId);
      if (declaration === undefined) {
        throw new Error(
          `Guide ${storyboard.slug} names the evidence capture ${captureId}, which does not exist.`,
        );
      }
      if (declaration.caseId !== caseId) {
        throw new Error(
          `Guide ${storyboard.slug} names the evidence capture ${captureId} for ${caseId}, but it belongs to ${declaration.caseId}.`,
        );
      }
      caseIds.add(declaration.caseId);
    }
  }
  return declarations.filter((declaration) => caseIds.has(declaration.caseId));
};
