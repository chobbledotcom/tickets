/**
 * The small non-secret phase journal each live scenario keeps under the
 * artifacts directory. Diagnostic evidence only: a failed workflow must never
 * automatically consume it to repeat an irreversible action.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactsRoot } from "#e2e/server.ts";

export interface JournalPhase {
  at: string;
  phase: string;
}

export interface ScenarioJournal {
  caseId: string;
  checkoutMayHaveHappened: boolean;
  finalLocalState: string | null;
  finalProviderObservation: string | null;
  pendingObserved: boolean;
  phases: JournalPhase[];
  provider: string;
  refundMayHaveLanded: boolean;
  /** Exact non-secret sandbox resource ids this scenario owns. */
  resourceIds: Record<string, string>;
  runId: string;
}

export const journalPath = (caseId: string): string =>
  join(artifactsRoot, `${caseId.replace(/[^a-z0-9-]/gi, "-")}-journal.json`);

export const newJournal = (
  runId: string,
  caseId: string,
  provider: string,
): ScenarioJournal => ({
  caseId,
  checkoutMayHaveHappened: false,
  finalLocalState: null,
  finalProviderObservation: null,
  pendingObserved: false,
  phases: [{ at: new Date().toISOString(), phase: "scenario-started" }],
  provider,
  refundMayHaveLanded: false,
  resourceIds: {},
  runId,
});

export const writeJournal = async (journal: ScenarioJournal): Promise<void> => {
  await writeFile(
    journalPath(journal.caseId),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
};
