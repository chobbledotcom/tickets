import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  prepareRefundReadiness,
  type ReadyRefundProvider,
} from "#routes/admin/refunds/readiness.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { HeldRefundClaim } from "#routes/admin/refunds/claim.ts";
import type {
  PaymentReferenceProviderBindingRequest,
  PaymentReferenceProviderBindingResult,
} from "#shared/db/payment-reference-provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { PaymentReferenceEvidence } from "#shared/payment/provider-discovery.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const charge = (): ChargeMoney => ({
  captured: { amount: 1000, currency: "GBP" },
  confirmedRefunded: { amount: 0, currency: "GBP" },
  refunds: [],
});

const referenceFacts = (
  index: string,
  refundState: RefundPaymentReference["refundState"] = "none",
) => ({
  heldRowSessionIds: [`session_${index}`],
  index,
  refundState,
  rowSessionIds: [`session_${index}`],
  sessionIds: [`session_${index}`],
});

const untagged = (
  reference: string,
  index = `old_${reference}`,
  refundState: RefundPaymentReference["refundState"] = "none",
): Extract<RefundPaymentReference, { kind: "untagged" }> => ({
  ...referenceFacts(index, refundState),
  kind: "untagged",
  reference,
});

const tagged = (
  reference: string,
  provider: PaymentProviderType,
  index = `tagged_${reference}`,
  refundState: RefundPaymentReference["refundState"] = "none",
): Extract<RefundPaymentReference, { kind: "tagged" }> => ({
  ...referenceFacts(index, refundState),
  kind: "tagged",
  provider,
  reference,
});

const candidate = (
  id: number,
  references: RefundPaymentReference[],
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references,
});

const heldClaim: HeldRefundClaim = {
  held: new Map([
    [1, ["session_old_shared", "session_tagged_returned"]],
    [2, ["session_old_shared"]],
  ]),
  heldSince: "2026-08-11T12:00:00.000Z",
};

const provider = (
  type: PaymentProviderType,
  refundCapability: ReadyRefundProvider["refundCapability"] = "keyed",
): ReadyRefundProvider => ({
  refundCapability,
  refundCharge: () =>
    Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
  type,
});

const found = (
  reference: RefundPaymentReference,
  provider: PaymentProviderType,
  observed: ChargeMoney,
): PaymentReferenceEvidence => ({
  attempts: [
    {
      provider,
      result: { resource: observed, status: "found" },
    },
  ],
  charge: observed,
  provider,
  reference: reference.reference,
  source: reference.kind === "tagged" ? "tagged" : "discovered",
  status: "found",
});

const boundIndexes = (
  bindings: PaymentReferenceProviderBindingRequest["bindings"],
): ReadonlyMap<string, string> =>
  new Map([...bindings.keys()].map((index) => [index, `bound_${index}`]));

describe("admin refund readiness", () => {
  test("deduplicates reads and carries exact evidence into every candidate", async () => {
    const observed = charge();
    const square = provider("square");
    const stripe = provider("stripe");
    const shared = untagged("shared");
    const returned = tagged(
      "returned",
      "stripe",
      "tagged_returned",
      "completed",
    );
    const reads: RefundPaymentReference[] = [];
    const loads: PaymentProviderType[] = [];
    const bindings: PaymentReferenceProviderBindingRequest[] = [];

    const result = await prepareRefundReadiness(
      [candidate(1, [shared, returned]), candidate(2, [shared])],
      heldClaim,
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
          reads.push(reference as RefundPaymentReference);
          return Promise.resolve(found(shared, "square", observed));
        },
      },
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.capability).toBe("keyed");
    expect(reads.map(({ index }) => index)).toEqual(["old_shared"]);
    expect(loads).toEqual(["square", "stripe"]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({
      bindings: new Map([
        [
          "old_shared",
          { kind: "tagged", provider: "square", reference: "shared" },
        ],
        [
          "tagged_returned",
          { kind: "tagged", provider: "stripe", reference: "returned" },
        ],
      ]),
      capability: "keyed",
      ...heldClaim,
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
    ) return;
    expect(observedFirst.charge).toBe(observed);
    expect(observedSecond.charge).toBe(observed);
    expect(observedFirst.provider).toBe(square);
    expect(observedSecond.provider).toBe(square);
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

  test("uses keyless capability when any resolved provider is keyless", async () => {
    const stripe = provider("stripe");
    const sumup = provider("sumup", "keyless");
    const references = [untagged("stripe_charge"), untagged("sumup_charge")];
    const bindingRequests: PaymentReferenceProviderBindingRequest[] = [];

    const result = await prepareRefundReadiness(
      [candidate(1, references)],
      { held: new Map([[1, references.map((entry) => entry.rowSessionIds[0]!)]]), heldSince: heldClaim.heldSince },
      new Set(),
      {
        bindProviders: (request) => {
          bindingRequests.push(request);
          return Promise.resolve({
            indexes: boundIndexes(request.bindings),
            kind: "bound",
          });
        },
        loadProvider: (type) =>
          Promise.resolve(type === "sumup" ? sumup : stripe),
        readEvidence: (reference) =>
          Promise.resolve(
            found(
              reference as RefundPaymentReference,
              reference.reference.startsWith("sumup") ? "sumup" : "stripe",
              charge(),
            ),
          ),
      },
    );

    expect(result.kind === "ready" && result.capability).toBe("keyless");
    expect(bindingRequests[0]?.capability).toBe("keyless");
  });

  for (const [name, returned, alreadyReturned] of [
    ["returned by the held claim", untagged("legacy_claim"), new Set(["old_legacy_claim"])],
    ["marked returned on its row", untagged("legacy_marker", undefined, "completed"), new Set<string>()],
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
        reason: "historical_marker",
      });
      expect(called).toBe(false);
    });
  }

  const unreadCases = [
    ["missing", { attempts: [{ provider: "stripe", result: { status: "missing" } }], provider: "stripe", reference: "unread", source: "tagged", status: "missing" }],
    ["invalid", { attempts: [{ provider: "stripe", result: { reason: "mismatched_id", status: "invalid" } }], provider: "stripe", reason: "mismatched_id", reference: "unread", source: "tagged", status: "invalid" }],
    ["unavailable", { attempts: [{ provider: "stripe", result: { reason: "timeout", status: "unavailable" } }], provider: "stripe", reason: "timeout", reference: "unread", source: "tagged", status: "unavailable" }],
    ["unresolved", { attempts: [{ provider: "square", result: { status: "missing" } }], reason: "no_validating_provider", reference: "unread", source: "untagged", status: "unresolved" }],
  ] as const satisfies readonly (readonly [string, PaymentReferenceEvidence])[];

  for (const [name, evidence] of unreadCases) {
    test(`keeps ${name} evidence and does not bind`, async () => {
      const reference = evidence.source === "tagged"
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
        reads: [{ evidence, index: "old_unread" }],
        reason: "provider_evidence",
      });
      expect(bindCount).toBe(0);
      expect(loadCount).toBe(0);
    });
  }

  test("keeps at most five provider evidence reads in flight", async () => {
    const references = Array.from({ length: 6 }, (_, index) =>
      untagged(`charge_${index}`)
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
      {
        bindProviders: (request) =>
          Promise.resolve({
            indexes: boundIndexes(request.bindings),
            kind: "bound",
          }),
        loadProvider: () => Promise.resolve(provider("stripe")),
        readEvidence: async (reference) => {
          active++;
          started++;
          highest = Math.max(highest, active);
          if (started === 5) firstWave.resolve();
          await gate.promise;
          active--;
          return found(reference as RefundPaymentReference, "stripe", charge());
        },
      },
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
          ? { kind: "not_ready", reason: "claim_changed" }
          : {
            indexes: bindingResult.indexes,
            kind: "not_ready",
            reason: "historical_marker",
          },
      );
    });
  }
});
