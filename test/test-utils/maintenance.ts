import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";

export const maintenanceContext = (
  remaining: SubrequestCounts,
  overrides: Partial<MaintenanceTaskContext> = {},
): MaintenanceTaskContext => ({
  budget: { remaining: () => remaining },
  checkpoint: null,
  completeTask: () => {},
  deadline: Date.now() + 10_000,
  requestFollowUp: () => {},
  setCheckpoint: () => {},
  ...overrides,
});

/** How many drain passes a test will wait for before giving up. Each pass
 *  handles one payment, so this bounds a runaway loop rather than the work. */
const MAX_SETTLE_PASSES = 20;

/**
 * Finish the payment work a callback deliberately left for later. A paid
 * callback only does the work that must happen while the buyer waits, so the
 * note, the ledger entries and the activity log are written by scheduled
 * maintenance afterwards. A test that checks any of those runs this first,
 * which is what the real site does a moment later.
 */
export const settleDeferredPaymentWork = async (): Promise<void> => {
  const { runPaymentMaintenance } = await import(
    "#shared/payment-runtime/maintenance.ts"
  );
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
    let askedForAnotherPass = false;
    await runPaymentMaintenance(
      maintenanceContext(
        { database: 40, external: 20, total: 60 },
        { requestFollowUp: () => (askedForAnotherPass = true) },
      ),
    );
    if (!askedForAnotherPass) return;
  }
  throw new Error("Deferred payment work did not settle");
};
