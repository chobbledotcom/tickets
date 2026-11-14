// test-groups: run-alone
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  cancellationFacts,
  controls,
} from "#scripts/verify-models/subscriptions/cancellation.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";
import {
  activeOverEnded,
  decodedCancellationData,
} from "./cancellation-fixture.ts";

const registeredControl = (name: string) =>
  requireValue(
    controls.find((control) => control.name === name),
    `Missing registered cancellation control: ${name}`,
  );

/** Each row names a test, its registered step control, the fact table, the
 * fields that select one fact, and the fields that the fact must hold. The
 * two field lists are JSON text. */
/* jscpd:ignore-start -- a list of strings, not code */
const STEP_CASES: readonly (readonly [
  title: string,
  control: string,
  table: string,
  where: string,
  expected: string,
])[] = [
  [
    "registers the premature-refund control on actual durable refund calls",
    "refund before confirmed external end",
    "Checkouts",
    '{"scenario":"retry","attempt":1}',
    '{"authorityReturned":600,"confirmed":false,"endOrder":0,"refundBeforeEnd":1,"refundOrder":2,"refunds":1,"threw":true}',
  ],
  [
    "registers the unsafe local-end control on stored status without final money",
    "local end without final returned money",
    "Owners",
    '{"scenario":"owner-ledger-fault"}',
    '{"after":"canceled","before":"active","cash":0,"legs":0,"returned":false,"threw":true}',
  ],
  [
    "registers the identity control on the actual cancellation request",
    "cancellation sent to another subscription",
    "Owners",
    '{"scenario":"owner-final"}',
    '{"after":"active","cancels":1,"cash":0,"requestId":"sub_wrong","subscriptionId":"sub_owner","threw":true}',
  ],
  [
    "independently controls the owner fallback subscription read target",
    "owner fallback read sent to another subscription",
    "Owners",
    '{"scenario":"owner-read-ended"}',
    '{"invoiceIdentityKept":true,"invoiceReads":1,"invoiceRequestId":"sub_owner","readIdentityKept":false,"readRequestId":"sub_wrong","reads":1,"requestId":"sub_owner","subscriptionId":"sub_owner"}',
  ],
  [
    "independently controls the owner paid-invoice read target",
    "owner invoice read sent to another subscription",
    "Owners",
    '{"scenario":"owner-final"}',
    '{"invoiceIdentityKept":false,"invoiceReads":1,"invoiceRequestId":"sub_wrong","readRequestId":"","reads":0,"requestId":"sub_owner","subscriptionId":"sub_owner"}',
  ],
  [
    "independently controls the rejected-checkout fallback read target",
    "failed checkout fallback read sent to another subscription",
    "Checkouts",
    '{"scenario":"read-ended"}',
    '{"invoiceReads":0,"readIdentityKept":false,"readRequestId":"sub_wrong","reads":1,"requestId":"sub_failed","subscriptionId":"sub_failed"}',
  ],
  [
    "exposes actual plan loss independently of the missing payment anchor",
    "anchorless retry lost its retained plan",
    "Checkouts",
    '{"scenario":"anchorless","attempt":2}',
    '{"after":"absent","attendeeId":-1,"bookingId":-1,"held":0,"heldAtCancel":0,"listingId":-1,"owned":true,"planAtCancel":1,"planKept":false,"planRows":0,"quantity":-1,"refunds":0,"signedOrder":true}',
  ],
  [
    "registers the duplicate-refund control on persisted replay multiplicity",
    "duplicate failed checkout refund on replay",
    "Checkouts",
    '{"scenario":"retry","attempt":3}',
    '{"durableRefunded":true,"paymentLegs":1,"refundCash":1200,"refundLegs":2,"refunds":1}',
  ],
  [
    "registers false completion when recorded authority lacks its stored refund",
    "false local refund completion",
    "Checkouts",
    '{"scenario":"retry","attempt":3}',
    '{"authorityLocal":"recorded","durableRefunded":true,"held":0,"refundCash":0,"refundLegs":0,"refunds":1}',
  ],
];
/* jscpd:ignore-end */

describe("SubscriptionCancellation negative controls", () => {
  for (const [title, name, table, where, expected] of STEP_CASES) {
    it(title, async () => {
      const control = registeredControl(name);
      expect(control.phase).toBe("step");
      const selected = Object.entries(JSON.parse(where));
      const facts = records(await control.data(), table).filter((fact) =>
        selected.every(([field, value]) => fact[field] === value),
      );
      expect(facts).toEqual([expect.objectContaining(JSON.parse(expected))]);
    });
  }

  it("registers the stale-overwrite control on a silent guarded SQL refusal", async () => {
    const control = registeredControl(
      "ended status overwritten by a stale live write",
    );
    expect(control.phase).toBe("step");
    const facts = await decodedCancellationData(control);
    expect(activeOverEnded(facts.writes)).toEqual([
      {
        affected: 0,
        after: "active",
        before: "canceled",
        snapshot: "active",
        target: "active",
      },
    ]);
  });

  it("registers missing coverage as an initial rather than unreachable step fault", async () => {
    const clean = await cancellationFacts();
    const control = registeredControl("missing owner cancellation evidence");
    expect(control.phase).toBe("initial");
    const facts = await decodedCancellationData(control);
    expect(facts.owners.map((fact) => fact.scenario)).toEqual(
      clean.owners
        .filter((fact) => fact.scenario !== "owner-final")
        .map((fact) => fact.scenario),
    );
    expect(
      facts.owners.filter((fact) => fact.scenario === "owner-final"),
    ).toEqual([]);
    expect(
      clean.owners.find((fact) => fact.scenario === "owner-final"),
    ).toMatchObject({
      after: "canceled",
      cash: 1200,
      returned: true,
    });
  });
});
