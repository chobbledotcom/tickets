import type { Buffer } from "node:buffer";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";

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
  // initialize() enables notify-only when the first page is served, but it is
  // memoized. Enable it for every later capture too, then restore strict test
  // behavior before the next scenario starts.
  setN1GuardNotifyOnly(true);
  try {
    const capture = await loadCapture();
    await capture(world, hook);
  } finally {
    // The capture's loopback server serves requests through serveHandler,
    // whose memoized initialize() flips the N+1 guard to notify-only on its
    // first call (src/serve-app.ts). Restore the default throw mode so one
    // capture cannot weaken the next scenario's checks.
    setN1GuardNotifyOnly(null);
  }
};
