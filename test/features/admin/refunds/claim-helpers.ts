import type {
  ClaimResult,
  LoadedRefundAttendee,
} from "#db/payment-claim/take.ts";
import type { RowSettlement } from "#db/payment-claim.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";

export type ClaimedRows = Extract<ClaimResult, { kind: "claimed" }>;

export type RecordingClaim = RowClaim & {
  settlements: RowSettlement[];
  requests: (readonly LoadedRefundAttendee[])[];
};

export const claimResult = (
  result: ClaimResult,
  settle: RowClaim["settle"] = () => Promise.resolve(),
): RecordingClaim => {
  const settlements: RowSettlement[] = [];
  const requests: RecordingClaim["requests"] = [];
  return {
    claim: (attendees) => {
      requests.push(attendees);
      return Promise.resolve(result);
    },
    requests,
    settle: (settlement) => {
      settlements.push(settlement);
      return settle(settlement);
    },
    settlements,
  };
};

export const claimedRows = (
  held: ReadonlyMap<number, readonly string[]>,
  unrecorded: ReadonlyMap<number, readonly string[]> = new Map(),
): ClaimedRows => ({
  commandId: "test-command",
  held,
  heldSince: "2026-08-11T12:00:00.000Z",
  kind: "claimed",
  phases: new Map(
    [...held.values()].flat().map((sessionId) => [sessionId, "checking"]),
  ),
  returned: new Set(["pi_returned"]),
  reviews: new Map(),
  shared: new Map(),
  unrecorded,
});

export const LOADED = [
  { attendeeId: 99, loadedPiiBlob: "sealed", references: [] },
] satisfies readonly LoadedRefundAttendee[];
