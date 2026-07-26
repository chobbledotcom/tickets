import { After, Before, type ITestCaseHookParameter } from "@cucumber/cucumber";
import {
  captureScenarioEvidence,
  EVIDENCE_HOOK_TIMEOUT_MS,
  SPEC_EVIDENCE_ENV,
} from "#scripts/specs/evidence/hook.ts";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { clearTestEncryptionKey } from "#test-utils/env.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";
import {
  addDatabaseCleanup,
  cleanupWorld,
  type TicketsWorld,
} from "./world.ts";

Before(async function (this: TicketsWorld): Promise<void> {
  this.cleanup = [];
  this.evidenceValues = new Map();
  this.listingIds = new Map();
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
        await cleanupWorld(this);
      } finally {
        reclaimLeakedFdsNow();
      }
    }
  },
);
