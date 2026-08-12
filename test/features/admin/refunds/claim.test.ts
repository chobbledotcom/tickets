import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type RefundRunBlock,
  underAttendeeClaim,
} from "#routes/admin/refunds/claim.ts";
import type { InheritedArmedRefunds } from "#shared/db/payment-claim/take.ts";
import { refundReference } from "#test-utils/payment-state.ts";
import {
  type ClaimedRows,
  claimedRows,
  claimResult,
  LOADED,
} from "./claim-helpers.ts";

describe("admin refunds > attendee claim", () => {
  test("reports a changed payment set without starting work", async () => {
    const claim = claimResult({ kind: "changed" });
    let worked = false;

    const result = await underAttendeeClaim<
      RefundRunBlock | { readonly kind: "work" }
    >(claim, LOADED, 7, {
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
    expect(claim.requests).toEqual([LOADED]);
    expect(claim.settlements).toEqual([]);
  });

  test("reports the reason another live claim refused the run", async () => {
    const claim = claimResult({
      blockedBy: { kind: "held" },
      kind: "blocked",
    });

    const result = await underAttendeeClaim(claim, LOADED, 8, {
      blocked: (block: RefundRunBlock) => block,
      work: () => Promise.reject(new Error("work must not start")),
    });

    expect(result).toEqual({
      kind: "claim_held",
      reason: "a refund for this payment is already in progress",
    });
    expect(claim.requests).toEqual([LOADED]);
    expect(claim.settlements).toEqual([]);
  });

  test("releases only attendees whose provider answer is settled", async () => {
    const inherited: InheritedArmedRefunds = new Map([
      [4, new Map([["pi-four", "keyless"]])],
    ]);
    const unrecorded = new Map<number, readonly string[]>([
      [3, ["sess-three"]],
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
        unrecorded,
      ),
    );

    const result = await underAttendeeClaim(claim, LOADED, 9, {
      blocked: () => "blocked",
      work: ({
        alreadyReturned,
        findings,
        inherited: inheritedClaims,
        unrecorded: existingUnrecorded,
      }) => {
        expect([...alreadyReturned]).toEqual(["pi_returned"]);
        expect(inheritedClaims).toBe(inherited);
        expect(existingUnrecorded).toBe(unrecorded);
        expect(findings).toEqual({
          claimPhases: new Map([
            ["sess-one", "checking"],
            ["sess-two", "checking"],
            ["sess-three", "checking"],
            ["sess-four", "checking"],
          ]),
          doubts: new Map([[4, "unread"]]),
          recorded: new Set(),
          reviews: new Map(),
          unrecorded: new Map(),
        });
        findings.doubts.set(2, "in_doubt");
        findings.doubts.set(3, "unread");
        findings.doubts.set(4, "unread");
        findings.unrecorded.set(1, ["sess-one"]);
        findings.unrecorded.set(2, ["sess-two"]);
        findings.unrecorded.set(3, ["sess-three"]);
        findings.unrecorded.set(4, ["sess-four"]);
        findings.reviews.set("sess-one", {
          kind: "review",
          reason: { kind: "partial_refund" },
        });
        findings.reviews.set("sess-two", {
          kind: "resolved",
          reason: "partial_refund",
        });
        findings.reviews.set("sess-three", {
          kind: "review",
          reason: { kind: "shared_reference" },
        });
        findings.reviews.set("sess-four", {
          kind: "resolved",
          reason: "shared_reference",
        });
        return Promise.resolve("worked");
      },
    });

    expect(result).toBe("worked");
    expect(claim.settlements).toEqual([
      {
        commandId: "test-command",
        heldSince: "2026-08-11T12:00:00.000Z",
        rows: new Map([
          [
            "sess-one",
            {
              books: "unrecorded",
              claim: "release",
              phase: "checking",
              review: {
                kind: "review",
                reason: { kind: "partial_refund" },
              },
            },
          ],
          [
            "sess-two",
            {
              books: "unrecorded",
              claim: "keep",
              phase: "checking",
              review: { kind: "resolved", reason: "partial_refund" },
            },
          ],
          [
            "sess-three",
            {
              books: "unrecorded",
              claim: "release",
              phase: "checking",
              review: {
                kind: "review",
                reason: { kind: "shared_reference" },
              },
            },
          ],
          [
            "sess-four",
            {
              books: "unrecorded",
              claim: "keep",
              phase: "checking",
              review: { kind: "resolved", reason: "shared_reference" },
            },
          ],
        ]),
      },
    ]);
  });

  test("does not ask the database to release an empty row set", async () => {
    const claim = claimResult(claimedRows(new Map([[1, []]])));

    const result = await underAttendeeClaim(claim, [], 10, {
      blocked: () => "blocked",
      work: () => Promise.resolve("worked"),
    });

    expect(result).toBe("worked");
    expect(claim.settlements).toEqual([]);
  });

  test("protects a returned marker carried by a sharing row", async () => {
    const reference = refundReference("shared", {
      index: "own-index",
      matchingIndexes: ["own-index", "sharing-index"],
      rowSessionIds: ["own-row"],
      sessionIds: ["own-row"],
    });
    const loaded = [
      {
        attendeeId: 1,
        loadedPiiBlob: "sealed",
        references: [reference],
      },
    ];
    const claimed = {
      ...claimedRows(
        new Map([
          [1, ["own-row"]],
          [2, ["sharing-row"]],
        ]),
      ),
      returned: new Set(["sharing-index"]),
      shared: new Map([
        [
          "own-index",
          [
            { attendeeId: 1, index: "own-index", sessionId: "own-row" },
            {
              attendeeId: 2,
              index: "sharing-index",
              sessionId: "sharing-row",
            },
          ],
        ],
      ]),
    } satisfies ClaimedRows;
    const claim = claimResult(claimed);

    await underAttendeeClaim(claim, loaded, 10, {
      blocked: () => "blocked",
      work: ({ findings }) => {
        expect(findings.unrecorded).toEqual(new Map([[2, ["sharing-row"]]]));
        return Promise.resolve("worked");
      },
    });

    expect(claim.settlements[0]?.rows.get("sharing-row")?.books).toBe(
      "unrecorded",
    );
  });
});
