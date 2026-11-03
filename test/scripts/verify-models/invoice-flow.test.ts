/** The invoice lifecycle facts: the stored result of each production action,
 *  and the two negative controls the checker must reject. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  invoiceFlowFacts,
  isOpenInvoiceRefusal,
} from "#scripts/verify-models/invoice-flow.ts";
import { records } from "#test-utils/tla-data.ts";
import { registeredModel } from "./registered-model.ts";

type Fact = Record<string, string | boolean | number>;

const { data: invoiceFlowModelData, controls } = registeredModel("InvoiceFlow");
const secondOpenInvoiceData = controls[0].data;
const reopenedInvoiceData = controls[1]!.data;

const factsOf = async (
  source: () => Promise<string>,
): Promise<readonly Fact[]> => records(await source(), "Attempts");

/** Every fact that runs the given action, with an optional extra condition. */
const attempts = (
  facts: readonly Fact[],
  kind: string,
  extra: (fact: Fact) => boolean = () => true,
): readonly Fact[] => facts.filter((fact) => fact.kind === kind && extra(fact));

const cleanFacts = (): Promise<readonly Fact[]> =>
  factsOf(invoiceFlowModelData);

describe("invoice flow checker data", () => {
  test("every clean fact agrees with the action that made it", async () => {
    const facts = await cleanFacts();

    expect(facts.filter((fact) => fact.safe !== true)).toEqual([]);
    expect(facts).toHaveLength(20);
  });

  test("a create beside the open invoice is refused by the index", async () => {
    const refused = attempts(
      await cleanFacts(),
      "create",
      (fact) => fact.otherNew === true,
    );

    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((fact) => fact.accepted === false)).toBe(true);
    expect(refused.every((fact) => fact.statusAfter === "absent")).toBe(true);
  });

  test("a create on a free number while the other is closed lands", async () => {
    const accepted = attempts(
      await cleanFacts(),
      "create",
      (fact) => fact.otherNew === false,
    );

    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((fact) => fact.accepted === true)).toBe(true);
    expect(accepted.every((fact) => fact.statusAfter === "new")).toBe(true);
  });

  test("a cancel closes only an open invoice", async () => {
    const facts = await cleanFacts();
    const open = attempts(
      facts,
      "cancel",
      (fact) => fact.statusBefore === "new",
    );
    const closed = attempts(
      facts,
      "cancel",
      (fact) => fact.statusBefore !== "new",
    );

    expect(open.every((fact) => fact.accepted === true)).toBe(true);
    expect(open.every((fact) => fact.statusAfter === "cancelled")).toBe(true);
    expect(closed.every((fact) => fact.accepted === false)).toBe(true);
    expect(closed.every((fact) => fact.statusAfter === fact.statusBefore)).toBe(
      true,
    );
  });

  test("a settle pays the open invoice only when its balance guard held", async () => {
    const facts = attempts(
      await cleanFacts(),
      "settle",
      (fact) => fact.statusBefore === "new",
    );
    const matched = facts.filter((fact) => fact.guardMatched === true);
    const unmatched = facts.filter((fact) => fact.guardMatched === false);

    expect(matched.every((fact) => fact.accepted === true)).toBe(true);
    expect(matched.every((fact) => fact.statusAfter === "paid")).toBe(true);
    expect(unmatched.every((fact) => fact.accepted === false)).toBe(true);
    expect(unmatched.every((fact) => fact.statusAfter === "new")).toBe(true);
  });

  test("a settle leaves a closed invoice closed", async () => {
    const closed = attempts(
      await cleanFacts(),
      "settle",
      (fact) => fact.statusBefore !== "new",
    );

    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((fact) => fact.accepted === false)).toBe(true);
    expect(closed.every((fact) => fact.statusAfter === fact.statusBefore)).toBe(
      true,
    );
  });

  test("the second-open control corrupts every create that met an open one", async () => {
    const clean = await cleanFacts();
    const victims = clean.filter(
      (fact) =>
        fact.kind === "create" &&
        fact.otherNew === true &&
        fact.accepted === false,
    );
    const corrupted = await factsOf(secondOpenInvoiceData);
    const unsafe = corrupted.filter((fact) => fact.safe !== true);

    expect(victims.length).toBeGreaterThan(0);
    expect(corrupted).toHaveLength(clean.length);
    expect(unsafe).toHaveLength(victims.length);
    for (const fact of unsafe)
      expect(fact).toMatchObject({
        accepted: true,
        acceptedCorrect: false,
        kind: "create",
        otherNew: true,
        statusAfter: "new",
        statusAfterCorrect: false,
      });
  });

  test("the reopened control corrupts every cancel on a cancelled invoice", async () => {
    const clean = await cleanFacts();
    const victims = clean.filter(
      (fact) => fact.kind === "cancel" && fact.statusBefore === "cancelled",
    );
    const corrupted = await factsOf(reopenedInvoiceData);
    const unsafe = corrupted.filter((fact) => fact.safe !== true);

    expect(victims.length).toBeGreaterThan(0);
    expect(corrupted).toHaveLength(clean.length);
    expect(unsafe).toHaveLength(victims.length);
    for (const fact of unsafe)
      expect(fact).toMatchObject({
        accepted: true,
        acceptedCorrect: false,
        kind: "cancel",
        statusAfter: "new",
        statusAfterCorrect: false,
        statusBefore: "cancelled",
      });
  });

  test("an unexpected insert failure escapes instead of refusing", async () => {
    await expect(
      invoiceFlowFacts({ run: () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
  });

  test("only the open-invoice index failure is a refusal", () => {
    expect(
      isOpenInvoiceRefusal(
        new Error("UNIQUE constraint failed: invoices.attendee_id"),
      ),
    ).toBe(true);
    expect(
      isOpenInvoiceRefusal(new Error("UNIQUE constraint failed: x.y")),
    ).toBe(false);
    expect(isOpenInvoiceRefusal("SQLITE_CONSTRAINT")).toBe(false);
  });
});
