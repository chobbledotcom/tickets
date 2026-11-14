// test-groups: run-alone
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { MODEL_TIME } from "#scripts/verify-models/subscriptions/environment.ts";
import { controls } from "#scripts/verify-models/subscriptions/renewals.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

type Match = Record<string, string | number | boolean>;
type Example = {
  name: string;
  table: string;
  where: Match;
  expected: Match | null;
};

const snapshotExamples: readonly [string, Match][] = [
  [
    "wrong-renewal-cash",
    { afterCashAmount: 601, afterSaleAmount: 500, afterVatAmount: 100 },
  ],
  [
    "corrupt-stored-renewal-vat",
    { afterCashAmount: 600, afterSaleAmount: 500, afterVatAmount: 101 },
  ],
  ["wrong-renewal-attendee", { afterCashDestination: "attendee:999999" }],
  ["wrong-renewal-listing", { afterSaleDestination: "revenue:999999" }],
  [
    "wrong-renewal-paid-time",
    { afterCashPaidAt: Date.parse(MODEL_TIME) / 1000 + 1 },
  ],
  ["duplicate-renewal-cash-leg", { afterCashAmount: 600, afterCashCount: 2 }],
];

const examples: readonly Example[] = [
  ...snapshotExamples.map(([name, expected]) => ({
    expected,
    name,
    table: "InvoiceFacts",
    where: { attempt: "normal:0" },
  })),
  {
    expected: { outcome: "returned", snapshotAttendee: 25, storedAttendee: 26 },
    name: "replaced-booking-accepted",
    table: "OperationFacts",
    where: { scenario: "identity_attendee" },
  },
  {
    expected: {
      afterStatus: "canceled",
      beforeStatus: "trialing",
      outcome: "write_fault",
    },
    name: "partial-renewal-status-commit",
    table: "OperationFacts",
    where: { attempt: "rollback:0" },
  },
  {
    expected: {
      amount: 200_000_004,
      observedTax: 100_000_002,
      price: 200_000_003,
      tax: 100_000_001,
    },
    name: "wrong-exact-renewal-tax",
    table: "ArithmeticFacts",
    where: { caseId: "below_half" },
  },
  {
    expected: null,
    name: "missing-renewal-attempt",
    table: "OperationFacts",
    where: { attempt: "normal:0" },
  },
  {
    expected: { allMatch: false, status: "found" },
    name: "foreign-renewal-currency-accepted",
    table: "CurrencyFacts",
    where: { caseId: "foreign_currency" },
  },
  {
    expected: { observedAmount: 1202, price: 1203, requestedAmount: 1202 },
    name: "rewritten-joined-plan",
    table: "JourneyFacts",
    where: { phase: "edited" },
  },
  {
    expected: {
      observedSubscription: "sub_wrong_join",
      refunds: 1,
      subscription: "sub_failed",
    },
    name: "broken-failed-checkout-identity-join",
    table: "FailedJoinFacts",
    where: { attempt: 2 },
  },
  {
    expected: { ordinal: 0, target: "sub_wrong_read" },
    name: "wrong-renewal-subscription-read",
    table: "ReadFacts",
    where: { kind: "renewal", owner: "normal:0" },
  },
  {
    expected: { ordinal: 0, target: "sub_wrong_read" },
    name: "wrong-invoice-list-subscription",
    table: "ReadFacts",
    where: { kind: "currency", owner: "site_currency" },
  },
  {
    expected: null,
    name: "missing-renewal-arithmetic",
    table: "ArithmeticFacts",
    where: { caseId: "planned" },
  },
  {
    expected: null,
    name: "missing-renewal-currency",
    table: "CurrencyFacts",
    where: { caseId: "site_currency" },
  },
  {
    expected: {
      expectedTrialAt: Date.parse("2024-02-29T10:15:00Z") / 1000,
      trialAt: Date.parse("2024-02-29T10:15:00Z") / 1000 + 1,
    },
    name: "wrong-joined-trial-time",
    table: "JourneyFacts",
    where: { phase: "edited" },
  },
  {
    expected: null,
    name: "missing-provider-read",
    table: "ReadFacts",
    where: { kind: "currency", owner: "site_currency" },
  },
];

for (const example of examples) {
  test(`renewal control exposes ${example.name}`, async () => {
    const control = requireValue(
      controls.find((item) => item.name === example.name),
      `Missing renewal control ${example.name}`,
    );
    const data = await control.data();
    const observed = records(data, example.table).filter((fact) =>
      Object.entries(example.where).every(
        ([key, value]) => fact[key] === value,
      ),
    );
    const expected =
      example.expected === null
        ? []
        : [expect.objectContaining(example.expected)];
    expect(observed).toEqual(expected);
    if (example.expected === null) {
      expect(
        records(data, "OperationFacts").filter(
          (fact) => fact.attempt === "normal:1",
        ),
      ).toEqual([
        expect.objectContaining({
          afterStatus: "active",
          beforeStatus: "active",
          outcome: "returned",
        }),
      ]);
    }
  });
}

test("the duplicate-read control retains both events with the same target", async () => {
  const control = requireValue(
    controls.find((item) => item.name === "duplicate-provider-read"),
    "Missing duplicate provider read control",
  );
  const data = await control.data();
  expect(
    records(data, "ReadFacts").filter(
      (fact) => fact.kind === "currency" && fact.owner === "site_currency",
    ),
  ).toEqual([
    {
      kind: "currency",
      ordinal: 0,
      owner: "site_currency",
      target: "sub_currency",
    },
    {
      kind: "currency",
      ordinal: 1,
      owner: "site_currency",
      target: "sub_currency",
    },
  ]);
});
