// test-groups: run-alone
import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { lazyRef } from "#fp";
import { lifecycleFacts } from "#scripts/verify-models/subscriptions/lifecycle.ts";
import {
  type LifecycleFacts,
  lifecycleCases,
  lifecycleScenario,
} from "#scripts/verify-models/subscriptions/lifecycle-facts.ts";
import { requireValue } from "#shared/required-value.ts";
import { registeredModel } from "#test/scripts/verify-models/registered-model.ts";
import { records } from "#test-utils/tla-data.ts";

/** One clean producer run serves every test in the first group. */
const [clean, setClean] = lazyRef<LifecycleFacts>(() => {
  throw new Error("The lifecycle facts load before the first test.");
});

const move = (scenario: string) =>
  requireValue(
    clean().moves.find((fact) => fact.scenario === scenario),
    `Missing lifecycle move: ${scenario}`,
  );

/** Each row names a test, the move, and the fields that the move must hold.
 * A move name is command/reply/stored/provider/paid/recorded. */
/* jscpd:ignore-start -- a list of strings, not code */
const MOVE_CASES: readonly (readonly [
  title: string,
  scenario: string,
  expected: string,
])[] = [
  [
    "the check stores a new live status with its paid renewal",
    "check/answers/trialing/active/1/0",
    '{"cancels":0,"invoiceReads":1,"otherLegs":0,"outcome":"returned","providerAfter":"active","reads":1,"recordedAfter":1,"storedAfter":"active"}',
  ],
  [
    "the check ends a row in the write that records its last renewal",
    "check/answers/active/canceled/1/0",
    '{"invoiceReads":1,"reads":1,"recordedAfter":1,"storedAfter":"canceled"}',
  ],
  [
    "the check leaves the row when the invoice read is refused",
    "check/invoices-refused/active/canceled/1/0",
    '{"invoiceReads":1,"reads":1,"recordedAfter":0,"storedAfter":"active"}',
  ],
  [
    "the check leaves the row when the subscription read is refused",
    "check/subscription-refused/active/canceled/1/0",
    '{"invoiceReads":0,"reads":1,"recordedAfter":0,"storedAfter":"active"}',
  ],
  [
    "the check never asks Stripe about an ended row",
    "check/answers/canceled/active/1/0",
    '{"cancels":0,"invoiceReads":0,"reads":0,"recordedAfter":0,"storedAfter":"canceled"}',
  ],
  [
    "the owner cancels a live row and keeps its last renewal",
    "cancel/answers/active/active/1/0",
    '{"cancels":1,"invoiceReads":1,"outcome":"cancelled","providerAfter":"canceled","reads":0,"recordedAfter":1,"storedAfter":"canceled"}',
  ],
  [
    "the owner reads the end that Stripe already holds",
    "cancel/answers/past_due/incomplete_expired/1/0",
    '{"cancels":1,"outcome":"cancelled","providerAfter":"incomplete_expired","reads":1,"recordedAfter":1,"storedAfter":"incomplete_expired"}',
  ],
  [
    "the owner reads that the page is behind when the invoice read is refused",
    "cancel/invoices-refused/active/active/1/0",
    '{"cancels":1,"outcome":"behind","providerAfter":"canceled","recordedAfter":0,"storedAfter":"active"}',
  ],
  [
    "the owner reads that Stripe did not cancel",
    "cancel/subscription-refused/active/active/1/1",
    '{"cancels":1,"invoiceReads":0,"outcome":"not_cancelled","providerAfter":"active","reads":1,"recordedAfter":1,"storedAfter":"active"}',
  ],
  [
    "the owner cannot cancel an ended row",
    "cancel/answers/canceled/canceled/1/1",
    '{"cancels":0,"invoiceReads":0,"outcome":"ended","reads":0,"recordedAfter":1,"storedAfter":"canceled"}',
  ],
];

/** Each row names a registered control, its phase, the move it changes, and
 * the fields that the changed move must hold. Null means the move is gone. */
const CONTROL_CASES: readonly (readonly [
  name: string,
  phase: string,
  scenario: string,
  expected: string,
])[] = [
  [
    "local end before the Stripe end",
    "step",
    "check/answers/active/active/0/0",
    '{"providerAfter":"active","storedAfter":"canceled"}',
  ],
  [
    "renewal recorded twice",
    "step",
    "check/answers/active/active/1/1",
    '{"paid":1,"recordedAfter":2}',
  ],
  [
    "ended row opened again",
    "step",
    "check/answers/canceled/canceled/0/0",
    '{"stored":"canceled","storedAfter":"active"}',
  ],
  [
    "cancelled answer without an end",
    "step",
    "cancel/subscription-refused/active/active/0/0",
    '{"outcome":"cancelled","storedAfter":"active"}',
  ],
  [
    "end before the last renewal",
    "step",
    "check/answers/active/canceled/1/0",
    '{"paid":1,"recordedAfter":0,"storedAfter":"canceled"}',
  ],
  [
    "missing lifecycle move",
    "initial",
    "cancel/answers/active/active/0/0",
    "null",
  ],
];
/* jscpd:ignore-end */

describe("SubscriptionLifecycle production evidence", () => {
  beforeAll(async () => {
    setClean(await lifecycleFacts());
  });

  it("runs every command against every state and reply, in the expected order", () => {
    const expected = lifecycleCases().map(lifecycleScenario);
    expect(expected.length).toBe(1152);
    expect(new Set(expected).size).toBe(1152);
    expect(clean().moves.map((fact) => fact.scenario)).toEqual(expected);
    expect(clean().moves.map((fact) => fact.position)).toEqual(
      expected.map((_, index) => index + 1),
    );
  });

  it("starts each command from the state that its case names", () => {
    for (const fact of clean().moves) {
      const [command, reply, stored, provider, paid, recorded] =
        fact.scenario.split("/");
      expect({
        command: fact.command,
        paid: String(fact.paid),
        provider: fact.provider,
        recorded: String(fact.recorded),
        reply: fact.reply,
        stored: fact.stored,
      }).toEqual({ command, paid, provider, recorded, reply, stored });
    }
  });

  for (const [title, scenario, expected] of MOVE_CASES) {
    it(title, () => {
      expect(move(scenario)).toMatchObject(JSON.parse(expected));
    });
  }
});

describe("SubscriptionLifecycle negative controls", () => {
  const { controls } = registeredModel("SubscriptionLifecycle");

  it("registers each control once", () => {
    expect(controls.map((control) => control.name).toSorted()).toEqual(
      CONTROL_CASES.map(([name]) => name).toSorted(),
    );
  });

  for (const [name, phase, scenario, expected] of CONTROL_CASES) {
    it(`changes its own move: ${name}`, async () => {
      const control = requireValue(
        controls.find((entry) => entry.name === name),
        `Missing registered lifecycle control: ${name}`,
      );
      expect(control.phase).toBe(phase);
      const changed = records(await control.data(), "Moves").filter(
        (fact) => fact.scenario === scenario,
      );
      const wanted = JSON.parse(expected);
      expect(changed).toEqual(
        wanted === null ? [] : [expect.objectContaining(wanted)],
      );
    });
  }
});
