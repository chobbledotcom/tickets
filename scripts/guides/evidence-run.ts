import { EVIDENCE_CAPTURES } from "#scripts/specs/evidence/declarations.ts";
import { evidenceRunFor } from "#scripts/specs/evidence/run.ts";
import { guideEvidenceDeclarations } from "./evidence-cases.ts";
import { GUIDE_STORYBOARDS } from "./storyboards/index.ts";

/** Capture only the evidence that the guide storyboards name. */
export const runGuideEvidenceSpecs = evidenceRunFor(
  guideEvidenceDeclarations(EVIDENCE_CAPTURES, GUIDE_STORYBOARDS),
);
