/* jscpd:ignore-start -- imports */
import { type ClaimRequest, decideClaim, holdsTheRow } from "#payment/claim.ts";
import {
  EMPTY_ROW_STATE,
  type RefundClaim,
  type RefundClaimPhase,
} from "#payment/row-state.ts";
import {
  checkingClaimFor,
  claimHeldBy,
  grantClaim,
  type HeldRowClaim,
  settledRowState,
} from "#payment/row-transitions.ts";
import {
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";

/* jscpd:ignore-end */

/** One worker run. Two runs on the same refund work contend for one row. */
type Run = {
  readonly commandId: string;
  readonly id: string;
  readonly writtenAt: string;
};

/** The one attendee set both runs refund, so one run can resume the other's
 *  crashed work. */
const REQUEST: ClaimRequest = { attendeeIds: [7], scope: "attendee_set" };

/** The two runs. Distinct command ids and write times keep the three claim
 *  comparison facts apart. */
const RUNS: readonly Run[] = [
  {
    commandId: "refund-run-a",
    id: "w1",
    writtenAt: "2026-01-01T00:00:00.000Z",
  },
  {
    commandId: "refund-run-b",
    id: "w2",
    writtenAt: "2026-01-02T00:00:00.000Z",
  },
];

/** The cutoff far after every written claim, so the claim reads as stale. */
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

/** A return time for the settlement, unused by the claim decision. */
const RETURNED_AT = "2026-01-03T00:00:00.000Z";

const claimFor = (run: Run): RefundClaim =>
  checkingClaimFor(REQUEST, run.commandId, run.writtenAt);

const workerFenceFields = {
  commandId: "Str",
  phase: "Str",
  worker: "Str",
  writtenAt: "Str",
} as const;
const takeFields = {
  admitted: "Bool",
  existingClaimStale: "Bool",
  existingOwner: "Str",
  newCommandId: "Str",
  newPhase: "Str",
  newWrittenAt: "Str",
  worker: "Str",
} as const;
const settleFields = {
  accepted: "Bool",
  fenceCommandId: "Str",
  fencePhase: "Str",
  fenceWorker: "Str",
  fenceWrittenAt: "Str",
  storedCommandId: "Str",
  storedOwner: "Str",
  storedPhase: "Str",
  storedWrittenAt: "Str",
} as const;
type WorkerFenceFact = TlaFact<typeof workerFenceFields>;
type TakeFact = TlaFact<typeof takeFields>;
type SettleFact = TlaFact<typeof settleFields>;

/** A fence a settling run may try. `phase` is a plain string because the
 *  phase control steps outside the current "checking" literal. */
type Fence = {
  readonly commandId: string;
  readonly phase: string;
  readonly worker: string;
  readonly writtenAt: string;
};

const heldFence = (fence: Fence): HeldRowClaim => ({
  commandId: fence.commandId,
  heldSince: fence.writtenAt,
  phase: fence.phase as RefundClaimPhase,
});

/** The four fences one run can try: its exact hold, then each of the three
 *  comparison facts changed on its own. */
const fencesFor = (run: Run): readonly Fence[] => {
  const other = requireValue(
    RUNS.find((candidate) => candidate.id !== run.id),
    "The second worker is absent",
  );
  const variants: readonly (readonly [string, string, string])[] = [
    [run.commandId, run.writtenAt, "checking"],
    [other.commandId, run.writtenAt, "checking"],
    [run.commandId, other.writtenAt, "checking"],
    [run.commandId, run.writtenAt, "other"],
  ];
  return variants.map(([commandId, writtenAt, phase]) => ({
    commandId,
    phase,
    worker: run.id,
    writtenAt,
  }));
};

/** Whether the row transition releases a claim under this fence. The phase
 *  control cannot pass through `settledRowState`, whose phase type is fixed to
 *  "checking", so it asks the claim comparison directly. */
const settleAccepts = (stored: RefundClaim, fence: Fence): boolean => {
  if (fence.phase !== "checking") return claimHeldBy(stored, heldFence(fence));
  return (
    settledRowState(
      grantClaim(EMPTY_ROW_STATE, stored),
      { claim: "release", phase: "checking" },
      { commandId: fence.commandId, heldSince: fence.writtenAt },
      RETURNED_AT,
    ) !== null
  );
};

const workerFences = (): WorkerFenceFact[] =>
  RUNS.map((run) => {
    const claim = claimFor(run);
    return {
      commandId: claim.commandId,
      phase: claim.phase,
      worker: run.id,
      writtenAt: claim.writtenAt,
    };
  });

/** Every take decision a worker can meet, from the real claim decision. The
 *  existing claim is the owner run's actual claim, judged stale or fresh by a
 *  cutoff that makes `isClaimStale` say so. An absent row is one owner whose
 *  claim is missing. */
const takeFacts = (): TakeFact[] => {
  const owners = new Map<string, RefundClaim | undefined>([
    ["none", undefined],
    ...RUNS.map((run) => [run.id, claimFor(run)] as const),
  ]);
  const facts: TakeFact[] = [];
  for (const taker of RUNS) {
    for (const stale of [false, true]) {
      for (const [owner, existing] of owners) {
        const staleBefore = stale
          ? FAR_FUTURE
          : (existing?.writtenAt ?? FAR_FUTURE);
        facts.push({
          admitted: holdsTheRow(decideClaim(existing, REQUEST, staleBefore)),
          existingClaimStale: stale,
          existingOwner: owner,
          newCommandId: taker.commandId,
          newPhase: "checking",
          newWrittenAt: taker.writtenAt,
          worker: taker.id,
        });
      }
    }
  }
  return facts;
};

/** Every settle attempt on a stored claim, from the real row transition. Each
 *  fence changes at most one comparison fact, so the model can prove each
 *  component of the hold fence on its own. */
const settleFacts = (): SettleFact[] => {
  const facts: SettleFact[] = [];
  for (const owner of RUNS) {
    const stored = claimFor(owner);
    for (const run of RUNS) {
      for (const fence of fencesFor(run)) {
        facts.push({
          accepted: settleAccepts(stored, fence),
          fenceCommandId: fence.commandId,
          fencePhase: fence.phase,
          fenceWorker: fence.worker,
          fenceWrittenAt: fence.writtenAt,
          storedCommandId: stored.commandId,
          storedOwner: owner.id,
          storedPhase: stored.phase,
          storedWrittenAt: stored.writtenAt,
        });
      }
    }
  }
  return facts;
};

/** The generated checker data. Every decision comes from the production claim
 *  and row transition functions; no stored copy supplies the proof. */
export const twoWorkersModelData: ModelDataSource = async () =>
  tlaModule("TwoWorkersData", [
    `Workers == ${tlaSet(RUNS.map((run) => run.id))}`,
    `CommandIds == ${tlaSet(RUNS.map((run) => run.commandId))}`,
    `WrittenAts == ${tlaSet(RUNS.map((run) => run.writtenAt))}`,
    `Phases == ${tlaSet(["checking", "other"])}`,
    tlaRecords("WorkerFenceFacts", workerFenceFields, workerFences()),
    tlaRecords("TakeFacts", takeFields, takeFacts()),
    tlaRecords("SettleFacts", settleFields, settleFacts()),
  ]);
