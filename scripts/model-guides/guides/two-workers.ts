import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** An old refund run must not release the replacement claim. */
/* jscpd:ignore-start -- static data, not code */
export const twoWorkers: ModelGuide = {
  badOutcome:
    "A paused run returns after its lease expires and clears the claim that a second run now holds.",
  cast: [
    {
      meaning:
        "One attempt by the code to return a payment. The examples use w1 and w2.",
      term: "refund run",
    },
    {
      meaning:
        "The right of one run to work on a payment row until the run settles.",
      term: "claim",
    },
    {
      meaning: "The time for which the application treats a claim as live.",
      term: "lease",
    },
    {
      meaning:
        "The exact command id, write time, and phase that a settle must match.",
      term: "fence",
    },
    {
      meaning:
        "A claim past the cutoff. Another run can then take over the same attendee work.",
      term: "stale claim",
    },
    {
      meaning:
        "The act of a run that records its result and releases its claim.",
      term: "settle",
    },
  ],
  claim:
    "This page follows one payment claim through two refund runs. A run takes the row only when no claim exists or the claim is stale. A settle needs the exact stored command, write time, and phase. An old run cannot release a replacement claim.",
  limits: [
    "The examples use two runs for attendee set [7] and selected timestamps.",
    "The model treats the selected cutoffs as live or expired. No clock runs.",
    "storedOwner and the worker flags are model records, not database columns.",
    "The steps explore event order. They do not execute SQL races or provider requests.",
    "The model does not prove that a run finishes or that a refund occurs once.",
  ],
  module: "TwoWorkers",
  safety:
    "A stored owner holds a claim. A no-owner row has empty claim fields. Every accepted take sees no claim or a stale claim. Every accepted settle matches the full stored claim fence. An old run's held flag does not authorize a release.",
  steps: [
    {
      code: [
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "checkingClaimFor",
        },
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "claimHeldBy",
        },
      ],
      rules: ["Init", "TypeOK", "ClaimFieldsConsistent", "OwnerHolds"],
      title: "Start with no claim",
      values: [
        { name: "storedOwner", value: "none" },
        { name: "storedCommandId", value: "empty" },
        { name: "storedWrittenAt", value: "empty" },
        { name: "storedPhase", value: "empty" },
        { name: "storedClaimStale", value: "FALSE" },
        { name: "worker1Held and worker2Held", value: "FALSE" },
      ],
      what: "No claim means one owner none and empty fields. The claim fields are model records, not database columns. checkingClaimFor shows the canonical claim shape that a take writes. The start state is before either run obtains a claim, not before payment creation.",
    },
    {
      code: [
        {
          path: "src/shared/payment/claim.ts",
          symbol: "decideClaim",
        },
        {
          path: "src/shared/payment/claim.ts",
          symbol: "holdsTheRow",
        },
      ],
      rules: ["TakeStep", "TakeAdmitsOnlyAbsentOrExpired"],
      title: "w1 takes an absent claim",
      values: [
        { name: "event", value: "w1 take" },
        { name: "existingOwner", value: "none" },
        { name: "decision", value: "grant" },
        { name: "admitted", value: "TRUE" },
        { name: "storedOwner", value: "w1" },
        { name: "storedCommandId", value: "refund-run-a" },
        { name: "storedWrittenAt", value: "2026-01-01T00:00:00.000Z" },
        { name: "storedPhase", value: "checking" },
        { name: "worker1Held", value: "TRUE" },
      ],
      what: "decideClaim returns grant for an absent claim. holdsTheRow turns that decision into admitted TRUE. The take fact supplies the fence fields, and the step writes them to the row. The request uses attendee set [7] with scope attendee_set.",
    },
    {
      code: [
        {
          path: "src/shared/payment/claim.ts",
          symbol: "decideClaim",
        },
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "checkingClaimFor",
        },
      ],
      rules: ["TakeStep", "ClaimFieldsConsistent", "OwnerHolds"],
      title: "A live claim refuses w2",
      values: [
        { name: "event", value: "w2 take" },
        { name: "existingOwner", value: "w1" },
        { name: "existingClaimStale", value: "FALSE" },
        { name: "decision", value: "held" },
        { name: "admitted", value: "FALSE" },
        { name: "stored fields", value: "unchanged" },
      ],
      what: "A live claim returns held. The take is refused and changes no field. The fence fields stay w1's. A live claim must refuse another take, even from the same run.",
    },
    {
      code: [
        {
          path: "src/shared/payment/claim.ts",
          symbol: "isClaimStale",
        },
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "grantClaim",
        },
      ],
      rules: ["LeaseExpiry", "TakeStep", "OwnerHolds", "ClaimFieldsConsistent"],
      title: "Lease expiry lets w2 take over",
      values: [
        { name: "storedClaimStale", value: "FALSE changes to TRUE" },
        { name: "w2 decision", value: "resume" },
        { name: "admitted", value: "TRUE" },
        { name: "storedOwner", value: "w1 changes to w2" },
        {
          name: "storedCommandId",
          value: "refund-run-a changes to refund-run-b",
        },
        {
          name: "storedWrittenAt",
          value: "2026-01-01T00:00:00.000Z changes to 2026-01-02T00:00:00.000Z",
        },
        { name: "worker1Held", value: "TRUE, not cleared" },
        { name: "worker2Held", value: "TRUE" },
      ],
      what: "The lease expiry sets only the stale flag. Both runs request attendee 7 with scope attendee_set, so the stale claim is resumable. grantClaim replaces the claim on purpose. The model keeps worker1Held because expiry changes permission, not the old run's history.",
    },
    {
      code: [
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "claimHeldBy",
        },
        {
          path: "src/shared/payment/row-transitions.ts",
          symbol: "settledRowState",
        },
      ],
      rules: ["SettleStep", "SettleFenceIsExact"],
      title: "w1 returns and tries to settle",
      values: [
        { name: "w1 fence command", value: "refund-run-a" },
        { name: "w1 fence write time", value: "2026-01-01T00:00:00.000Z" },
        { name: "w1 fence phase", value: "checking" },
        { name: "stored command", value: "refund-run-b" },
        { name: "w1 accepted", value: "FALSE, no change" },
        { name: "w2 accepted", value: "TRUE" },
        {
          name: "after w2 settle",
          value: "storedOwner none, worker2Held FALSE, worker1Held stays TRUE",
        },
      ],
      what: "claimHeldBy compares command, write time, and phase. The old fence does not match, so settledRowState returns null and changes nothing. w2's exact fence releases the claim. A corrupt fact that accepts w1's fence violates SettleFenceIsExact.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/two-workers.ts",
          symbol: "corruptSettleData",
        },
        {
          path: "scripts/verify-models/two-workers.ts",
          symbol: "twoWorkersModelData",
        },
      ],
      rules: ["Safety", "Next", "SettleStep", "TakeStep"],
      title: "Safety joins the claim laws",
      values: [
        {
          name: "accepted w1 settle on w2's claim",
          value: "SettleFenceIsExact FALSE. Safety fails.",
        },
        {
          name: "take with admitted TRUE on a live claim",
          value: "TakeAdmitsOnlyAbsentOrExpired FALSE. Safety fails.",
        },
        { name: "pause", value: "All values stay equal." },
      ],
      what: "Safety joins the type, claim field, owner, take, and settle laws. TakeStep and SettleStep apply the chosen prepared fact. LeaseExpiry changes only the stale flag. Next also permits a pause, so no run or provider answer is forced.",
    },
  ],
  title: "Keeping one refund claim safe across two workers and an old lease",
};
/* jscpd:ignore-end */
