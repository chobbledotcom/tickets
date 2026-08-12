import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import type {
  PaymentReferenceProviderBindingRequest,
  PaymentReferenceProviderBindingResult,
} from "#shared/db/payment-reference-provider.ts";
import type { PaymentReferenceEvidence } from "#shared/payment/provider-discovery.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import {
  boundIndexes,
  candidate,
  charge,
  found,
  heldClaim,
  provider,
  stripeReadiness,
  tagged,
  untagged,
} from "./readiness/helpers.ts";

describe("admin refund readiness", () => {
  test("deduplicates reads and carries exact evidence into every candidate", async () => {
    const observed = charge();
    const square = provider("square");
    const stripe = provider("stripe");
    const shared = untagged("shared");
    const firstShared: typeof shared = {
      ...shared,
      heldRowSessionIds: ["session_first"],
      rowSessionIds: ["session_first"],
      sessionIds: ["session_first"],
    };
    const secondShared: typeof shared = {
      ...shared,
      heldRowSessionIds: ["session_second"],
      rowSessionIds: ["session_second"],
      sessionIds: ["session_second"],
    };
    const returned = tagged(
      "returned",
      "stripe",
      "tagged_returned",
      "completed",
    );
    const reads: string[] = [];
    const loads: PaymentProviderType[] = [];
    const bindings: PaymentReferenceProviderBindingRequest[] = [];
    const exactClaim = {
      commandId: heldClaim.commandId,
      held: new Map([
        [1, ["session_first", "session_tagged_returned"]],
        [2, ["session_second"]],
      ]),
      heldSince: heldClaim.heldSince,
      phases: new Map([
        ["session_first", "checking" as const],
        ["session_tagged_returned", "checking" as const],
        ["session_second", "checking" as const],
      ]),
    };

    const result = await prepareRefundReadiness(
      [candidate(1, [firstShared, returned]), candidate(2, [secondShared])],
      exactClaim,
      new Set(),
      {
        bindProviders: (request) => {
          bindings.push(request);
          return Promise.resolve({
            indexes: boundIndexes(request.bindings),
            kind: "bound",
          });
        },
        loadProvider: (type) => {
          loads.push(type);
          return Promise.resolve(type === "square" ? square : stripe);
        },
        readEvidence: (reference) => {
          reads.push(reference.reference);
          return Promise.resolve(found(shared, "square", observed));
        },
      },
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(reads).toEqual(["shared"]);
    expect(loads).toEqual(["square", "stripe"]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({
      bindings: new Map([
        [
          "old_shared",
          {
            capability: "keyed",
            identity: {
              kind: "tagged",
              provider: "square",
              reference: "shared",
            },
          },
        ],
        [
          "tagged_returned",
          {
            capability: "keyed",
            identity: {
              kind: "tagged",
              provider: "stripe",
              reference: "returned",
            },
          },
        ],
      ]),
      ...exactClaim,
    });
    const [first, second] = result.candidates;
    const observedFirst = first?.references[0];
    const returnedFirst = first?.references[1];
    const observedSecond = second?.references[0];
    expect(observedFirst?.kind).toBe("observed");
    expect(observedSecond?.kind).toBe("observed");
    if (
      observedFirst?.kind !== "observed" ||
      observedSecond?.kind !== "observed"
    ) {
      return;
    }
    expect(observedFirst.charge).toBe(observed);
    expect(observedSecond.charge).toBe(observed);
    expect(observedFirst.provider).toBe(square);
    expect(observedSecond.provider).toBe(square);
    expect(observedFirst.reference.rowSessionIds).toEqual(["session_first"]);
    expect(observedSecond.reference.rowSessionIds).toEqual(["session_second"]);
    expect(observedFirst.reference).toMatchObject({
      index: "bound_old_shared",
      kind: "tagged",
      provider: "square",
    });
    expect(returnedFirst?.kind).toBe("already_returned");
    if (returnedFirst?.kind !== "already_returned") return;
    expect(returnedFirst.provider).toBe(stripe);
    expect(returnedFirst.reference.index).toBe("bound_tagged_returned");
  });

  for (const [name, returned, alreadyReturned] of [
    [
      "returned by the held claim",
      untagged("legacy_claim"),
      new Set(["old_legacy_claim"]),
    ],
    [
      "marked returned on its row",
      untagged("legacy_marker", undefined, "completed"),
      new Set<string>(),
    ],
  ] as const) {
    test(`quarantines an untagged reference ${name} without provider calls`, async () => {
      let called = false;
      const result = await prepareRefundReadiness(
        [candidate(1, [returned])],
        heldClaim,
        alreadyReturned,
        {
          bindProviders: () => {
            called = true;
            return Promise.resolve({ kind: "claim_changed" });
          },
          loadProvider: () => {
            called = true;
            return Promise.resolve(provider("stripe"));
          },
          readEvidence: () => {
            called = true;
            return Promise.resolve(found(returned, "stripe", charge()));
          },
        },
      );

      expect(result).toEqual({
        indexes: [returned.index],
        kind: "not_ready",
        observations: [],
        reason: "historical_marker",
      });
      expect(called).toBe(false);
    });
  }

  const unreadCases = [
    [
      "missing",
      {
        attempts: [{ provider: "stripe", result: { status: "missing" } }],
        provider: "stripe",
        reference: "unread",
        source: "tagged",
        status: "missing",
      },
    ],
    [
      "invalid",
      {
        attempts: [
          {
            provider: "stripe",
            result: { reason: "mismatched_id", status: "invalid" },
          },
        ],
        provider: "stripe",
        reason: "mismatched_id",
        reference: "unread",
        source: "tagged",
        status: "invalid",
      },
    ],
    [
      "unavailable",
      {
        attempts: [
          {
            provider: "stripe",
            result: { reason: "timeout", status: "unavailable" },
          },
        ],
        provider: "stripe",
        reason: "timeout",
        reference: "unread",
        source: "tagged",
        status: "unavailable",
      },
    ],
    [
      "unresolved",
      {
        attempts: [{ provider: "square", result: { status: "missing" } }],
        reason: "no_validating_provider",
        reference: "unread",
        source: "untagged",
        status: "unresolved",
      },
    ],
    [
      "incomplete discovery",
      {
        attempts: [
          {
            provider: "square",
            result: { resource: charge(), status: "found" },
          },
          {
            provider: "stripe",
            result: { reason: "timeout", status: "unavailable" },
          },
        ],
        reason: "provider_search_incomplete",
        reference: "unread",
        source: "untagged",
        status: "unresolved",
      },
    ],
  ] as const satisfies readonly (readonly [string, PaymentReferenceEvidence])[];

  for (const [name, evidence] of unreadCases) {
    test(`keeps ${name} evidence and does not bind`, async () => {
      const reference =
        evidence.source === "tagged"
          ? tagged("unread", "stripe", "old_unread")
          : untagged("unread", "old_unread");
      let bindCount = 0;
      let loadCount = 0;
      const result = await prepareRefundReadiness(
        [candidate(1, [reference])],
        heldClaim,
        new Set(),
        {
          bindProviders: () => {
            bindCount++;
            return Promise.resolve({ kind: "claim_changed" });
          },
          loadProvider: () => {
            loadCount++;
            return Promise.resolve(provider("stripe"));
          },
          readEvidence: () => Promise.resolve(evidence),
        },
      );

      expect(result).toEqual({
        kind: "not_ready",
        observations: [],
        reads: [{ evidence, index: "old_unread" }],
        reason: "provider_evidence",
      });
      expect(bindCount).toBe(0);
      expect(loadCount).toBe(0);
    });
  }

  test("keeps at most five provider evidence reads in flight", async () => {
    const references = Array.from({ length: 6 }, (_, index) =>
      untagged(`charge_${index}`),
    );
    const gate = Promise.withResolvers<void>();
    const firstWave = Promise.withResolvers<void>();
    let active = 0;
    let highest = 0;
    let started = 0;
    const running = prepareRefundReadiness(
      [candidate(1, references)],
      heldClaim,
      new Set(),
      stripeReadiness(async (reference) => {
        active++;
        started++;
        highest = Math.max(highest, active);
        if (started === 5) firstWave.resolve();
        await gate.promise;
        active--;
        return found(reference, "stripe", charge());
      }),
    );

    await firstWave.promise;
    expect(started).toBe(5);
    expect(highest).toBe(5);
    gate.resolve();
    expect((await running).kind).toBe("ready");
    expect(started).toBe(6);
    expect(highest).toBe(5);
  });

  for (const bindingResult of [
    { kind: "claim_changed" },
    { indexes: ["old_raced_marker"], kind: "historical_marker" },
  ] as const satisfies readonly PaymentReferenceProviderBindingResult[]) {
    test(`maps the binding result ${bindingResult.kind}`, async () => {
      const reference = untagged("binding_result");
      const result = await prepareRefundReadiness(
        [candidate(1, [reference])],
        heldClaim,
        new Set(),
        {
          bindProviders: () => Promise.resolve(bindingResult),
          loadProvider: () => Promise.resolve(provider("stripe")),
          readEvidence: () =>
            Promise.resolve(found(reference, "stripe", charge())),
        },
      );

      expect(result).toEqual(
        bindingResult.kind === "claim_changed"
          ? {
            kind: "not_ready",
            observations: [{ charge: charge(), reference }],
            reason: "claim_changed",
          }
          : {
              indexes: bindingResult.indexes,
              kind: "not_ready",
              observations: [{ charge: charge(), reference }],
              reason: "historical_marker",
            },
      );
    });
  }
});
