import type { Buffer } from "node:buffer";
import type { GherkinDocument, Pickle } from "@cucumber/messages";

export const SPEC_EVIDENCE_ENV = "TICKETS_SPEC_EVIDENCE";
export const EVIDENCE_HOOK_TIMEOUT_MS = 120_000;

export interface EvidenceWorld {
  attach(
    data: Buffer,
    options: { fileName: string; mediaType: "image/png" },
  ): void | Promise<void>;
  evidenceValues: Map<string, string>;
}

export interface EvidenceHookCase {
  gherkinDocument: GherkinDocument;
  pickle: Pickle;
}

export type CaptureScenario = (
  world: EvidenceWorld,
  hook: EvidenceHookCase,
) => Promise<void>;

export const captureScenarioEvidence = async (
  world: EvidenceWorld,
  hook: EvidenceHookCase,
  mode: string | undefined,
  loadCapture: () => Promise<CaptureScenario>,
): Promise<void> => {
  if (mode !== "1") return;
  const capture = await loadCapture();
  await capture(world, hook);
};
