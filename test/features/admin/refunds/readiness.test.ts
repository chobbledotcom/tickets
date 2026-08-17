import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import {
  candidate,
  charge,
  heldClaim,
  provider,
  tagged,
} from "./readiness/helpers.ts";

const claimFor = (
  rows: ReadonlyMap<number, readonly string[]>,
): typeof heldClaim => ({
  commandId: heldClaim.commandId,
  held: new Map(rows),
  heldSince: heldClaim.heldSince,
  phases: new Map(
    [...rows.values()].flatMap((sessionIds) =>
      sessionIds.map((sessionId) => [sessionId, "checking"] as const),
    ),
  ),
});

describe("admin refund readiness", () => {
  test("deduplicates tagged reads and carries exact evidence into every candidate", async () => {
    const observed = charge();
    const square = provider("square");
    const stripe = provider("stripe");
    const shared = tagged("shared", "square", "square_shared");
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
      "stripe_returned",
      "completed",
    );
    const reads: string[] = [];
    const loads: PaymentProviderType[] = [];
    const readCharge = (
      reference: string,
    ): Promise<ProviderRead<ChargeMoney>> => {
      reads.push(reference);
      return Promise.resolve({ resource: observed, status: "found" });
    };
    const loadedSquare = { ...square, readCharge };
    const loadedStripe = { ...stripe, readCharge };
    const result = await prepareRefundReadiness(
      [candidate(1, [firstShared, returned]), candidate(2, [secondShared])],
      claimFor(
        new Map([
          [1, ["session_first", "session_stripe_returned"]],
          [2, ["session_second"]],
        ]),
      ),
      new Set(),
      {
        loadProvider: ({ provider: type }) => {
          loads.push(type);
          return Promise.resolve(
            type === "square" ? loadedSquare : loadedStripe,
          );
        },
      },
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(reads).toEqual(["shared"]);
    expect(loads).toEqual(["square", "stripe"]);
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
    expect(observedFirst.provider).toBe(loadedSquare);
    expect(observedSecond.provider).toBe(loadedSquare);
    expect(observedFirst.reference).toBe(firstShared);
    expect(observedSecond.reference).toBe(secondShared);
    expect(returnedFirst).toMatchObject({
      kind: "already_returned",
      provider: loadedStripe,
      reference: returned,
    });
  });

  const unreadCases = [
    ["missing", { status: "missing" }],
    ["invalid", { reason: "mismatched_id", status: "invalid" }],
    ["unavailable", { reason: "timeout", status: "unavailable" }],
  ] as const satisfies readonly (readonly [
    string,
    Exclude<ProviderRead<ChargeMoney>, { status: "found" }>,
  ])[];

  for (const [name, read] of unreadCases) {
    test(`keeps exact tagged ${name} evidence`, async () => {
      const reference = tagged("unread", "stripe", "stripe_unread");
      let loadCount = 0;
      const result = await prepareRefundReadiness(
        [candidate(1, [reference])],
        heldClaim,
        new Set(),
        {
          loadProvider: () => {
            loadCount++;
            return Promise.resolve({
              ...provider("stripe"),
              readCharge: () => Promise.resolve(read),
            });
          },
        },
      );

      expect(result).toEqual({
        kind: "not_ready",
        observations: [],
        reads: [
          {
            evidence: {
              ...read,
              provider: "stripe",
              reference: "unread",
            },
            index: "stripe_unread",
          },
        ],
        reason: "provider_evidence",
      });
      expect(loadCount).toBe(1);
    });
  }

  test("keeps at most five exact-provider reads in flight", async () => {
    const references = Array.from({ length: 6 }, (_, index) =>
      tagged(`charge_${index}`, "stripe"),
    );
    const gate = Promise.withResolvers<void>();
    const firstWave = Promise.withResolvers<void>();
    let active = 0;
    let highest = 0;
    let started = 0;
    const stripe = provider("stripe");
    const running = prepareRefundReadiness(
      [candidate(1, references)],
      heldClaim,
      new Set(),
      {
        loadProvider: () =>
          Promise.resolve({
            ...stripe,
            readCharge: async () => {
              active++;
              started++;
              highest = Math.max(highest, active);
              if (started === 5) firstWave.resolve();
              await gate.promise;
              active--;
              return { resource: charge(), status: "found" };
            },
          }),
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
});
