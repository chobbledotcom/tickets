// test-groups: run-alone
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, executeBatch } from "#db/client.ts";
import { withSubscriptionDb } from "#scripts/verify-models/subscriptions/environment.ts";
import {
  collectRecordFacts,
  controls,
} from "#scripts/verify-models/subscriptions/records.ts";
import type { RecordFacts } from "#scripts/verify-models/subscriptions/records-facts.ts";
import {
  recordScenarios,
  runRecordScenario,
} from "#scripts/verify-models/subscriptions/records-operations.ts";
import { projectionFacts } from "#scripts/verify-models/subscriptions/records-projection.ts";
import { records } from "#test-utils/tla-data.ts";

const scenario = (operation: string, status = "active", quantity = 0) => {
  const found = recordScenarios().find(
    (item) =>
      item.operation === operation &&
      item.status === status &&
      item.quantity === quantity,
  );
  if (!found) throw new Error("Missing record scenario");
  return found;
};

/** Runs one record scenario after one write that the scenario does not expect. */
const scenarioAfterWrite = (
  operation: string,
  sql: string,
  args: (string | number)[] = [],
) =>
  runRecordScenario(scenario(operation), async () => {
    await execute(sql, args);
  });

type ParsedFact = Record<string, string | boolean | number>;

const assertRefusedState = (fact: RecordFacts["operations"][number]) => {
  if (fact.accepted) return;
  expect({
    money: fact.moneyUnchanged,
    records: fact.recordsUnchanged,
  }).toEqual({ money: true, records: true });
};

/** Each stored plan field beside the field that holds its expected value. */
/* jscpd:ignore-start -- a list of strings, not code */
const PLAN_FIELDS = [
  ["attendee", "expectedAttendee"],
  ["interval", "expectedInterval"],
  ["listing", "expectedListing"],
  ["price", "expectedPrice"],
  ["afterQuantity", "expectedQuantity"],
  ["afterStatus", "expectedStatus"],
  ["subscription", "expectedSubscription"],
  ["tax", "expectedTax"],
] as const;
/* jscpd:ignore-end */

const assertStoredPlan = (fact: RecordFacts["operations"][number]) => {
  expect({ present: fact.present, rows: fact.rowCount }).toEqual({
    present: fact.expectedPresent,
    rows: fact.expectedRowCount,
  });
  if (!fact.present) return;
  for (const [stored, expected] of PLAN_FIELDS)
    expect([stored, fact[stored]]).toEqual([stored, fact[expected]]);
  if (fact.expectedBooking !== 0)
    expect(fact.booking).toBe(fact.expectedBooking);
};

const assertMergeStages = (fact: RecordFacts["operations"][number]) => {
  if (!fact.operation.startsWith("merge")) return;
  const validated = fact.expectedAccepted || fact.operation === "merge-fault";
  expect({
    applied: fact.applyRan,
    validated: fact.validationAccepted,
    validationUnchanged: fact.validationUnchanged,
  }).toEqual({ applied: validated, validated, validationUnchanged: true });
};

const preservedPlanControls = [
  ["lost-live-plan-remove", "edit-drop:active:0", "present", false],
  ["lost-live-plan-delete", "delete:active:0", "present", false],
  ["lost-live-plan-merge", "merge-drop-source:active:1", "present", false],
  [
    "wrong-preserved-plan-identity",
    "merge-move:active:0",
    "subscription",
    "sub_wrong",
  ],
  ["wrong-preserved-plan-amount", "merge-move:active:0", "price", 732],
  ["wrong-preserved-plan-tax", "merge-move:active:0", "tax", 114],
  ["wrong-preserved-plan-interval", "merge-move:active:0", "interval", "year"],
  [
    "wrong-preserved-plan-status",
    "merge-move:active:0",
    "afterStatus",
    "canceled",
  ],
] as const;

describe("subscription record production facts", () => {
  test("refuses every live removal without changing records or money", async () => {
    const { operations } = await collectRecordFacts();
    expect(operations).toHaveLength(218);
    expect(operations.map((fact) => fact.scenario)).toEqual(
      recordScenarios().map((input) => input.scenario),
    );
    for (const fact of operations) {
      expect({
        accepted: fact.accepted,
        listingRefused: fact.listingRefused,
        liveRead: fact.liveRead,
        moneyCorrect: fact.moneyCorrect,
      }).toEqual({
        accepted: fact.expectedAccepted,
        listingRefused: fact.live,
        liveRead: fact.live,
        moneyCorrect: true,
      });
      assertRefusedState(fact);
      assertStoredPlan(fact);
      assertMergeStages(fact);
    }
  });

  test("keeps exact plan columns on edits and real merge copies", async () => {
    for (const operation of [
      "edit-preserve",
      "merge-move",
      "merge-take-source",
      "merge-preserve-target",
    ]) {
      const fact = await runRecordScenario(scenario(operation));
      expect(fact.accepted).toBe(true);
      expect(fact.present).toBe(true);
      expect([
        fact.subscription,
        fact.price,
        fact.tax,
        fact.interval,
        fact.afterStatus,
      ]).toEqual([fact.expectedSubscription, 731, 113, "month", "active"]);
      expect(fact.attendee).toBe(fact.expectedAttendee);
      expect(fact.listing).toBe(11);
      expect(fact.afterQuantity).toBe(fact.expectedQuantity);
    }
  });

  test("permits ended and ordinary removals, including quantity zero", async () => {
    for (const status of ["canceled", "incomplete_expired", ""]) {
      for (const operation of [
        "edit-drop",
        "delete",
        "merge-drop-source",
        "merge-drop-target",
      ]) {
        const fact = await runRecordScenario(scenario(operation, status));
        expect(fact.accepted).toBe(true);
        expect(fact.present).toBe(false);
      }
    }
  });

  test("projects the independent booking universe without subscription deduplication", async () => {
    const facts = await withSubscriptionDb(() => projectionFacts());
    expect(facts.observed).toEqual(facts.expected);
    expect(
      facts.observed
        .filter((row) => row.quantity === 0)
        .map((row) => row.booking),
    ).toEqual([22, 19, 16, 13, 10, 7, 4, 1]);
    expect(
      facts.observed
        .filter((row) => row.subscription === "sub_shared")
        .map((row) => row.booking),
    ).toEqual([2, 1]);
    expect(facts.invalid).toEqual(
      [
        "missing-interval",
        "invalid-interval",
        "missing-status",
        "invalid-status",
      ].map((scenario) => ({
        attempt: 1,
        listThrows: true,
        pass: 1,
        scenario,
        singleThrows: true,
      })),
    );
  });

  test("exposes wrong persisted identity and amount before extraction", async () => {
    const fact = await scenarioAfterWrite(
      "merge-move",
      "UPDATE listing_attendees SET subscription_id = 'sub_wrong', recurring_price = 999 WHERE listing_id = 11",
    );
    expect(fact.subscription).toBe("sub_wrong");
    expect(fact.price).toBe(999);
    expect(fact.expectedSubscription).toBe("sub_protected");
    expect(fact.expectedPrice).toBe(731);
  });

  for (const [title, sql, expected] of [
    [
      "retains actual partial refusal rather than an expected safe state",
      "UPDATE attendees SET email_pending = 1 WHERE id = 1",
      { recordsUnchanged: false },
    ],
    [
      "exposes a changed ledger amount on a refused delete",
      "UPDATE transfers SET amount = 48 WHERE id = 1",
      { moneyCorrect: false, moneyUnchanged: false },
    ],
  ] as const) {
    test(title, async () => {
      const fact = await scenarioAfterWrite("delete", sql);
      expect(fact).toMatchObject({ accepted: false, ...expected });
    });
  }

  test("exposes omitted and misattributed projection rows", async () => {
    const facts = await withSubscriptionDb(() =>
      projectionFacts(async () => {
        await executeBatch([
          { args: [], sql: "DELETE FROM listing_attendees WHERE id = 1" },
          {
            args: [],
            sql: "UPDATE listing_attendees SET attendee_id = 999 WHERE id = 2",
          },
        ]);
      }),
    );
    expect(facts.expected.find((row) => row.booking === 1)).toMatchObject({
      attendee: 2,
      booking: 1,
      quantity: 0,
      subscription: "sub_shared",
    });
    expect(facts.observed.filter((row) => row.booking === 1)).toEqual([]);
    expect(facts.observed.find((row) => row.booking === 2)).toMatchObject({
      attendee: 999,
      booking: 2,
      quantity: 1,
      subscription: "sub_shared",
    });
  });

  test("exposes a live plan removed after an edit, delete, or merge refusal", async () => {
    for (const operation of ["edit-drop", "delete", "merge-drop-source"]) {
      const fact = await scenarioAfterWrite(
        operation,
        "DELETE FROM listing_attendees WHERE id = 1",
      );
      expect(fact.accepted).toBe(false);
      expect(fact.expectedPresent).toBe(true);
      expect(fact.present).toBe(false);
      expect(fact.recordsUnchanged).toBe(false);
      expect(() => assertStoredPlan(fact)).toThrow();
    }
  });

  test("exposes each corrupted frozen merge-plan column independently", async () => {
    for (const [column, value, observed] of [
      ["recurring_tax", 114, "tax"],
      ["recurring_interval", "year", "interval"],
      ["subscription_status", "canceled", "afterStatus"],
    ] as const) {
      const fact = await scenarioAfterWrite(
        "merge-move",
        `UPDATE listing_attendees SET ${column} = ? WHERE listing_id = 11`,
        [value],
      );
      expect(fact.accepted).toBe(true);
      expect(fact.present).toBe(true);
      expect(fact[observed]).toBe(value);
      expect({
        interval: fact.expectedInterval,
        status: fact.expectedStatus,
        tax: fact.expectedTax,
      }).toEqual({ interval: "month", status: "active", tax: 113 });
      expect(() => assertStoredPlan(fact)).toThrow();
    }
  });

  test("keeps two stored bookings even when their provider identity is equal", async () => {
    const facts = await withSubscriptionDb(() =>
      projectionFacts(async () => {
        await executeBatch([
          {
            args: [],
            sql: `INSERT INTO listing_attendees
        (id,attendee_id,listing_id,quantity,start_at,recurring_price,recurring_tax,
         recurring_interval,subscription_id,subscription_status)
        SELECT 201,attendee_id,listing_id,quantity,'2026-04-01',recurring_price,
               recurring_tax,recurring_interval,subscription_id,subscription_status
          FROM listing_attendees WHERE id = 1`,
          },
        ]);
      }),
    );
    expect(
      facts.observed
        .filter((row) => row.subscription === "sub_shared")
        .map((row) => row.booking),
    ).toEqual([201, 2, 1]);
  });

  test("propagates unexpected faults and restores the fixture scope", async () => {
    const fault = new Error("Unexpected boundary fault");
    await expect(
      runRecordScenario(scenario("merge-move"), () => Promise.reject(fault)),
    ).rejects.toBe(fault);
    expect((await runRecordScenario(scenario("delete"))).recordsUnchanged).toBe(
      true,
    );
  });

  test("exports effective named control data with separate phases", async () => {
    const baseline = await collectRecordFacts();
    expect(controls.map((control) => control.name)).toEqual([
      ...preservedPlanControls.map(([name]) => name),
      "partial-refusal",
      "partial-refusal-money",
      "misattributed-projected-booking",
      "omitted-quantity-zero-booking",
      "missing-required-record-domain",
      "duplicate-projected-booking",
    ]);
    for (const control of controls) {
      const corrupt = await control.data();
      const operations = records(corrupt, "OperationFacts") as ParsedFact[];
      const projected = records(corrupt, "ObservedProjection") as ParsedFact[];
      const planControl = preservedPlanControls.find(
        ([name]) => name === control.name,
      );
      if (planControl) {
        const [, scenario, field, value] = planControl;
        const before = baseline.operations.find(
          (fact) => fact.scenario === scenario,
        );
        const after = operations.find((fact) => fact.scenario === scenario);
        if (!before || !after) throw new Error("Missing preserved-plan event");
        expect(control.phase).toBe("step");
        expect(operations).toEqual(
          baseline.operations.map((fact) =>
            fact.scenario === scenario ? { ...fact, [field]: value } : fact,
          ),
        );
        expect(after.accepted).toBe(field !== "present");
        expect(after.accepted).toBe(before.accepted);
        expect(after.expectedPresent).toBe(true);
        expect(() =>
          assertStoredPlan(after as RecordFacts["operations"][number]),
        ).toThrow();
        continue;
      }
      switch (control.name) {
        case "partial-refusal":
          expect(
            operations.find((fact) => fact.scenario === "delete:active:0"),
          ).toMatchObject({ accepted: false, recordsUnchanged: false });
          break;
        case "partial-refusal-money":
          expect(
            operations.find((fact) => fact.scenario === "delete:active:0"),
          ).toMatchObject({ accepted: false, moneyUnchanged: false });
          break;
        case "omitted-quantity-zero-booking":
          expect(projected.filter((fact) => fact.booking === 1)).toEqual([]);
          break;
        case "duplicate-projected-booking":
          expect(
            projected
              .filter((fact) => fact.booking === 1)
              .map((fact) => fact.slot),
          ).toEqual([24, 999]);
          break;
        case "misattributed-projected-booking":
          expect(projected.find((fact) => fact.booking === 1)?.attendee).toBe(
            3,
          );
          break;
        case "missing-required-record-domain":
          expect(control.phase).toBe("initial");
          expect(operations.filter((fact) => fact.status === "paused")).toEqual(
            [],
          );
          break;
      }
    }
  });
});
