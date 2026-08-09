// jscpd:ignore-start
import { After, Before, type ITestCaseHookParameter } from "@cucumber/cucumber";
import {
  captureScenarioEvidence,
  EVIDENCE_HOOK_TIMEOUT_MS,
  SPEC_EVIDENCE_ENV,
} from "#scripts/specs/evidence/hook.ts";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { clearTestEncryptionKey } from "#test-utils/env.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";
import { namedThings, putsThingsBack } from "./memory.ts";
import { addDatabaseCleanup, type TicketsWorld } from "./world.ts";

// jscpd:ignore-end

Before(async function (this: TicketsWorld): Promise<void> {
  this.cleanup = putsThingsBack();
  this.evidenceCookies = new Map();
  this.evidencePages = new Map();
  this.things = namedThings();
  const cleanupDb = await setupTestDbEnvironment(true).catch((error) => {
    clearTestEncryptionKey();
    throw error;
  });
  addDatabaseCleanup(this, cleanupDb, clearTestEncryptionKey);
});

After(
  { timeout: EVIDENCE_HOOK_TIMEOUT_MS },
  async function (
    this: TicketsWorld,
    hook: ITestCaseHookParameter,
  ): Promise<void> {
    try {
      await captureScenarioEvidence(
        this,
        hook,
        process.env[SPEC_EVIDENCE_ENV],
        async () =>
          (await import("#scripts/specs/evidence/capture.ts"))
            .captureCurrentScenarioEvidence,
      );
    } finally {
      try {
        await this.cleanup.runAll();
      } finally {
        reclaimLeakedFdsNow();
      }
    }
  },
);
