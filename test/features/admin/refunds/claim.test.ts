import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type RefundRunBlock,
  type RowClaim,
  underAttendeeClaim,
} from "#routes/admin/refunds/claim.ts";
import type {
  ClaimResult,
  LoadedRefundAttendee,
} from "#shared/db/payment-claim/take.ts";
import type { RowRelease } from "#shared/db/payment-claim.ts";
import type {
  RefundCapability,
  ResolvedRefundCapability,
} from "#shared/payment/row-state.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

type ClaimedRows = Extract<ClaimResult, { kind: "claimed" }>;

type RecordingClaim = RowClaim & {
  releases: RowRelease[];
  requests: [readonly LoadedRefundAttendee[], RefundCapability][];
};

const claimResult = (
  result: ClaimResult,
  release: RowClaim["release"] = () => Promise.resolve(),
): RecordingClaim => {
  const releases: RowRelease[] = [];
  const requests: RecordingClaim["requests"] = [];
  return {
    claim: (attendees, capability) => {
      requests.push([attendees, capability]);
      return Promise.resolve(result);
    },
    release: (released) => {
      releases.push(released);
      return release(released);
    },
    releases,
    requests,
  };
};

const claimedRows = (
  held: ReadonlyMap<number, readonly string[]>,
  inherited: ReadonlyMap<number, ResolvedRefundCapability> = new Map(),
): ClaimedRows => ({
  held,
  heldSince: "2026-08-11T12:00:00.000Z",
  inherited,
  kind: "claimed",
  returned: new Set(["pi_returned"]),
});

const LOADED = [
  { attendeeId: 99, loadedPiiBlob: "sealed", references: [] },
] satisfies readonly LoadedRefundAttendee[];

describe("admin refunds > attendee claim", () => {
  const errors = setupErrorSpy();

  test("reports a changed payment set without starting work", async () => {
    const claim = claimResult({ kind: "changed" });
    let worked = false;

    const result = await underAttendeeClaim<
      RefundRunBlock | { readonly kind: "work" }
    >(claim, LOADED, "keyed", 7, {
      blocked: (block) => block,
      work: () => {
        worked = true;
        return Promise.resolve({ kind: "work" } as const);
      },
    });

    expect(result).toEqual({
      kind: "payment_set_changed",
      reason:
        "the attendee or payment set changed while this refund was starting",
    });
    expect(worked).toBe(false);
    expect(claim.requests).toEqual([[LOADED, "keyed"]]);
    expect(claim.releases).toEqual([]);
  });

  test("reports the reason another live claim refused the run", async () => {
    const claim = claimResult({
      blockedBy: { kind: "held" },
      kind: "blocked",
    });

    const result = await underAttendeeClaim(claim, LOADED, "keyless", 8, {
      blocked: (block: RefundRunBlock) => block,
      work: () => Promise.reject(new Error("work must not start")),
    });

    expect(result).toEqual({
      kind: "claim_held",
      reason: "a refund for this payment is already in progress",
    });
    expect(claim.requests).toEqual([[LOADED, "keyless"]]);
    expect(claim.releases).toEqual([]);
  });

  test("releases only attendees whose provider answer is settled", async () => {
    const inherited = new Map<number, ResolvedRefundCapability>([
      [4, "keyless"],
    ]);
    const claim = claimResult(
      claimedRows(
        new Map([
          [1, ["sess-one"]],
          [2, ["sess-two"]],
          [3, ["sess-three"]],
          [4, ["sess-four"]],
        ]),
        inherited,
      ),
    );

    const result = await underAttendeeClaim(claim, LOADED, "keyed", 9, {
      blocked: () => "blocked",
      work: ({ alreadyReturned, findings, inherited: inheritedClaims }) => {
        expect([...alreadyReturned]).toEqual(["pi_returned"]);
        expect(inheritedClaims).toBe(inherited);
        expect(findings).toEqual({
          doubts: new Map(),
          unrecorded: new Map(),
        });
        findings.doubts.set(2, "in_doubt");
        findings.doubts.set(3, "unread");
        findings.doubts.set(4, "unread");
        findings.unrecorded.set(1, ["missed-one"]);
        findings.unrecorded.set(2, ["missed-two"]);
        findings.unrecorded.set(3, ["missed-three"]);
        findings.unrecorded.set(4, ["missed-four"]);
        return Promise.resolve("worked");
      },
    });

    expect(result).toBe("worked");
    expect(claim.releases).toEqual([
      {
        heldSince: "2026-08-11T12:00:00.000Z",
        sessionIds: ["sess-one", "sess-three"],
        unrecorded: new Set(["missed-one", "missed-three"]),
      },
    ]);
  });

  test("does not ask the database to release an empty row set", async () => {
    const claim = claimResult(claimedRows(new Map([[1, []]])));

    const result = await underAttendeeClaim(claim, [], "keyed", 10, {
      blocked: () => "blocked",
      work: () => Promise.resolve("worked"),
    });

    expect(result).toBe("worked");
    expect(claim.releases).toEqual([]);
  });

  test("reports a release failure without losing the run result", async () => {
    const claim = claimResult(claimedRows(new Map([[1, ["sess-one"]]])), () =>
      Promise.reject(new Error("the row would not let go")),
    );

    const result = await underAttendeeClaim(claim, [], "keyed", 11, {
      blocked: () => "blocked",
      work: () => Promise.resolve("worked"),
    });

    expect(result).toBe("worked");
    expect(claim.releases).toHaveLength(1);
    expect(
      errors.contains(
        "Refund claim could not be released: Error: the row would not let go",
      ),
    ).toBe(true);
  });

  test("keeps every held attendee when work raises", async () => {
    const claim = claimResult(
      claimedRows(
        new Map([
          [1, ["sess-one"]],
          [2, ["sess-two"]],
        ]),
      ),
    );

    await expect(
      underAttendeeClaim(claim, [], "keyed", 12, {
        blocked: () => "blocked",
        work: ({ findings }) => {
          findings.unrecorded.set(1, ["missed-one"]);
          return Promise.reject(new Error("the ledger fell over"));
        },
      }),
    ).rejects.toThrow("the ledger fell over");

    expect(claim.releases).toEqual([]);
  });
});
