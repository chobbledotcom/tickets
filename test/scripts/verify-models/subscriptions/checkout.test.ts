// test-groups: run-alone

import { pick } from "@std/collections";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { once } from "#fp";
import { requireValue } from "#shared/required-value.ts";
import { registeredModel } from "#test/scripts/verify-models/registered-model.ts";
import { members, records } from "#test-utils/tla-data.ts";
import { checkoutControlCases } from "./checkout-control-cases.ts";

const model = registeredModel("SubscriptionCheckout");
/** One clean producer run serves every test in this file. */
const clean = once(() => model.data());
const cleanRecords = async (table: string) => records(await clean(), table);

/** Each observed field beside the field that holds its expected value. */
/* jscpd:ignore-start -- a list of strings, not code */
const REQUEST_EXPECTATIONS = {
  initialQuantity: "expectedQuantity",
  interval: "expectedInterval",
  invoiceRead: "firstInvoice",
  metadataListing: "listing",
  oneTimeAmount: "expectedInitial",
  oneTimeLines: "expectedOneTimeLines",
  ordinaryInitial: "expectedOrdinaryInitial",
  paymentReference: "expectedReference",
  recurringAmount: "expectedAmount",
  subscribedInitial: "expectedSubscribedInitial",
  subscriptionRead: "subscription",
  trialEnd: "expectedTrialEnd",
};
const PLAN_EXPECTATIONS = {
  amount: "expectedAmount",
  interval: "expectedInterval",
  status: "expectedStatus",
  subscription: "expectedSubscription",
  tax: "expectedTax",
};
const EDITED_ROW_FIELDS = [
  "amount",
  "attendee",
  "booking",
  "listing",
  "subscription",
] as const;
/* jscpd:ignore-end */

type Row = Readonly<Record<string, string | number | boolean>>;

/** The observed fields that differ from their expected fields. */
const mismatches = (row: Row, expectations: Readonly<Record<string, string>>) =>
  Object.entries(expectations).filter(
    ([field, expected]) => row[field] !== row[expected],
  );

/** An ordinary booking holds no plan. */
const ordinaryRow = (attendee: number, booking: number, listing: number) => ({
  amount: 0,
  attendee,
  booking,
  listing,
  subscription: "",
});
const requestScenarios = Array.from(
  { length: 40 },
  (_, index) => `checkout-${index + 1}`,
);
const allScenarios = [...requestScenarios, "local-41", "local-42", "local-43"];
const shapes = [
  "ordinary",
  "single",
  "extra",
  "multiple",
  "package",
  "addon",
  "deposit",
  "zero",
  "quantity-two",
  "quantity-zero",
];
const providers = ["stripe", "square", "sumup", "none"];

const TABLES = ["AdmissionFacts", "RequestFacts", "PlanFacts"] as const;
const UNIVERSES = ["AdmissionUniverse", "RequestUniverse", "PlanUniverse"];

/** The members of one checker set: the rows of a table, or the names of a
 * universe. */
const setOf = (data: string, name: string): unknown[] =>
  UNIVERSES.includes(name) ? members(data, name) : records(data, name);

/** A fact table that does not hold each expected identity one time. */
const hasCoverageFault = (data: string): boolean => {
  for (const [table, identity, universe] of [
    ["AdmissionFacts", "scenario", "AdmissionUniverse"],
    ["RequestFacts", "scenario", "RequestUniverse"],
    ["PlanFacts", "identity", "PlanUniverse"],
  ] as const) {
    const rows = records(data, table);
    const expected = members(data, universe);
    if (
      expected.length === 0 ||
      rows.length !== expected.length ||
      new Set(rows.map((row) => row[identity])).size !== expected.length ||
      rows.some((row) => !expected.includes(String(row[identity])))
    )
      return true;
  }
  return false;
};

/** A fact that breaks the law of its own row. */
const hasLawFault = (data: string): boolean => {
  if (
    records(data, "AdmissionFacts").some((fact) => {
      const supported =
        fact.provider === "stripe" &&
        fact.subscriptions === 1 &&
        fact.own === true;
      return (
        fact.checkoutAccepted !== (fact.subscriptions === 0 || supported) ||
        fact.orderAccepted !==
          (fact.subscriptions === 0 || (supported && Number(fact.total) > 0))
      );
    })
  )
    return true;
  return (
    records(data, "RequestFacts").some(
      (fact) =>
        fact.mode !== "subscription" ||
        fact.recurringLines !== 1 ||
        fact.recurringQuantity !== 1 ||
        fact.request === fact.session ||
        fact.firstInvoice === fact.subscription ||
        mismatches(fact, REQUEST_EXPECTATIONS).length > 0,
    ) ||
    records(data, "PlanFacts").some(
      (fact) => mismatches(fact, PLAN_EXPECTATIONS).length > 0,
    )
  );
};

/** Check emitted business evidence, independently of the controls' names. */
const hasBusinessFault = (data: string): boolean =>
  hasCoverageFault(data) || hasLawFault(data);

describe("subscription checkout production facts", () => {
  test("every provider retains each accepted and refused order shape", async () => {
    const admissions = await cleanRecords("AdmissionFacts");
    expect(admissions.map((f) => f.scenario)).toEqual(
      providers.flatMap((provider) =>
        shapes.map((shape) => `${provider}-${shape}`),
      ),
    );
    for (const provider of providers) {
      const outcomes = admissions.filter((f) => f.provider === provider);
      expect(
        outcomes.filter((f) => f.orderAccepted).map((f) => f.shape),
      ).toEqual(
        provider === "stripe"
          ? ["ordinary", "single", "extra", "deposit", "quantity-two"]
          : ["ordinary"],
      );
      expect(
        outcomes.filter((f) => f.checkoutAccepted).map((f) => f.shape),
      ).toEqual(
        provider === "stripe"
          ? [
              "ordinary",
              "single",
              "extra",
              "deposit",
              "zero",
              "quantity-two",
              "quantity-zero",
            ]
          : ["ordinary"],
      );
      expect(
        outcomes.filter((f) => !f.orderAccepted).map((f) => f.shape),
      ).toEqual(
        provider === "stripe"
          ? ["multiple", "package", "addon", "zero", "quantity-zero"]
          : shapes.filter((shape) => shape !== "ordinary"),
      );
    }
  });

  test("each request separates first-payment lines, recurring quantity and its own invoice", async () => {
    const requests = await cleanRecords("RequestFacts");
    expect(requests.map((f) => f.scenario)).toEqual(requestScenarios);
    for (const f of requests) {
      expect(mismatches(f, REQUEST_EXPECTATIONS)).toEqual([]);
      expect([f.mode, f.recurringLines, f.recurringQuantity]).toEqual([
        "subscription",
        1,
        1,
      ]);
    }
    expect(requests[0]).toMatchObject({
      firstInvoice: "in_first_1",
      listing: 11,
      oneTimeAmount: 2137,
      ordinaryInitial: 137,
      paymentReference: "pi_first_1",
      recurringAmount: 1002,
      request: "request_1",
      session: "cs_model_1",
      subscribedInitial: 2000,
      subscription: "sub_model_1",
      trialEnd: Date.parse("2027-01-04T10:15:00Z") / 1000,
    });
    expect([...new Set(requests.map((f) => f.trialEnd))].sort()).toEqual(
      [
        "2027-01-04T10:15:00Z",
        "2026-02-28T10:15:00Z",
        "2024-02-29T10:15:00Z",
        "2025-02-28T10:15:00Z",
        "2027-01-31T10:15:00Z",
      ]
        .map((date) => Date.parse(date) / 1000)
        .sort(),
    );
    expect([...new Set(requests.map((f) => f.taxMode))].sort()).toEqual([
      "add_to_total",
      "calculate_from_total",
      "none",
    ]);
    expect([...new Set(requests.map((f) => f.status))].sort()).toEqual([
      "active",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ]);
  });

  test("all six booking identities preserve their complete plans through later edits", async () => {
    const data = await clean();
    const rows = records(data, "PlanFacts");
    const expectedIdentities = allScenarios.flatMap((scenario, index) =>
      ["stored", "edited"].flatMap((stage) =>
        Array.from(
          { length: 6 },
          (_, row) => `${scenario}-${stage}-${(index + 1) * 100 + row}`,
        ),
      ),
    );
    expect(rows.map((f) => f.identity)).toEqual(expectedIdentities);
    expect(members(data, "PlanUniverse")).toEqual(expectedIdentities);
    for (const f of rows) expect(mismatches(f, PLAN_EXPECTATIONS)).toEqual([]);
    expect(
      rows
        .filter((f) => f.owned)
        .map((f) => ({
          booking: f.booking,
          identity: f.identity,
          listing: f.listing,
        })),
    ).toEqual(
      allScenarios.flatMap((scenario, index) =>
        ["stored", "edited"].map((stage) => ({
          booking: (index + 1) * 100 + 5,
          identity: `${scenario}-${stage}-${(index + 1) * 100 + 5}`,
          listing: (index + 1) * 10 + 1,
        })),
      ),
    );
    expect(
      rows
        .filter((f) => f.scenario === "checkout-1" && f.stage === "edited")
        .map((f) => pick(f, EDITED_ROW_FIELDS)),
    ).toEqual([
      { ...ordinaryRow(14, 100, 11), amount: 333, subscription: "sub_other_1" },
      ordinaryRow(14, 101, 12),
      ordinaryRow(13, 102, 12),
      ordinaryRow(13, 103, 11),
      ordinaryRow(13, 104, 11),
      {
        ...ordinaryRow(13, 105, 11),
        amount: 1002,
        subscription: "sub_model_1",
      },
    ]);
    expect(
      rows
        .filter((f) => f.owned && Number(f.quantity) === 0)
        .map((f) => ({
          amount: f.amount,
          quantity: f.quantity,
          scenario: f.scenario,
          stage: f.stage,
          tax: f.tax,
        })),
    ).toEqual(
      [0, 3, 9007199254740000].flatMap((amount, index) =>
        ["stored", "edited"].map((stage) => ({
          amount,
          quantity: 0,
          scenario: `local-${index + 41}`,
          stage,
          tax: index === 1 ? 2 : 0,
        })),
      ),
    );
  });

  test("each registered control emits a business law or coverage failure", async () => {
    expect(hasBusinessFault(await clean())).toBe(false);
    for (const control of model.controls) {
      const data = await control.data();
      if (control.scope === undefined) {
        expect(hasBusinessFault(data)).toBe(true);
        continue;
      }
      expect(hasLawFault(await control.scope())).toBe(false);
      expect(hasLawFault(data)).toBe(true);
    }
  });

  for (const expected of checkoutControlCases) {
    const matches = (fact: Row) =>
      Object.entries(expected.target).every(
        ([key, value]) => fact[key] === value,
      );
    /** The target's table after the control, from the rows before it. */
    const changedRows = (before: Row[], others: (fact: Row) => Row[]) =>
      before.flatMap((fact) => {
        if (!matches(fact)) return others(fact);
        return expected.after === null ? [] : [{ ...fact, ...expected.after }];
      });
    const registered = () =>
      requireValue(
        model.controls.find(({ name }) => name === expected.name),
        "Registered checkout control is missing",
      );
    const otherNames = [...TABLES, ...UNIVERSES].filter(
      (name) => name !== expected.table,
    );

    test(`registered control ${expected.name} names one clean target`, async () => {
      expect((await cleanRecords(expected.table)).filter(matches)).toEqual([
        expect.objectContaining({ ...expected.target, ...expected.before }),
      ]);
    });

    test(`registered control ${expected.name} exposes its precise business fault`, async () => {
      const control = registered();
      const cleanText = await clean();
      const corrupted = await control.data();
      const before: Row[] = records(cleanText, expected.table);
      if (control.scope === undefined) {
        expect(records(corrupted, expected.table)).toEqual(
          changedRows(before, (fact) => [fact]),
        );
        for (const name of otherNames) {
          expect(setOf(corrupted, name)).toEqual(setOf(cleanText, name));
        }
        return;
      }
      const kept = await control.scope();
      expect(records(kept, expected.table)).toEqual(before.filter(matches));
      expect(records(corrupted, expected.table)).toEqual(
        changedRows(before, () => []),
      );
      for (const name of otherNames) {
        expect(kept).toContain(`${name}Count == 0`);
        expect(corrupted).toContain(`${name}Count == 0`);
      }
    });
  }
});
