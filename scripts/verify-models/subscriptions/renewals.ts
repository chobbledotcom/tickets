/** Real renewal writes, stored observations, and independently checkable inputs. */

import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { requireValue } from "#shared/required-value.ts";
import { type Faults, producerFor } from "./controls.ts";
import { withSubscriptionDb } from "./environment.ts";
import { failedJourneyFacts, observeJourney } from "./journey.ts";
import { arithmeticFacts, RENEWAL_CASES } from "./renewal-cases.ts";
import { type RenewalFacts, renderRenewals } from "./renewal-facts.ts";
import { observeCase } from "./renewal-observations.ts";

/** Every invocation observes a fresh database; fault tests cannot read cached facts. */
export const renewalFacts = async (
  corruption: "none" | "stored_vat" = "none",
): Promise<RenewalFacts> => {
  const facts = await withSubscriptionDb(async () => {
    const facts: RenewalFacts = {
      arithmetic: arithmeticFacts(),
      expected: RENEWAL_CASES.flatMap((example) =>
        example.passes.map((_, index) => ({
          attempt: `${example.name}:${index}`,
          scenario: example.name,
        })),
      ),
      expectedInvoices: [],
      failedJoins: [],
      invoices: [],
      journeys: [],
      operations: [],
      reads: [],
      scenarios: [],
      snapshots: [],
    };
    if (corruption === "stored_vat")
      await execute(
        sql`CREATE TRIGGER model_corrupt_renewal_vat AFTER INSERT ON transfers
     WHEN NEW.kind = 'vat' AND NEW.source_id = '1'
     BEGIN UPDATE transfers SET amount = amount + 1 WHERE id = NEW.id; END`,
      );
    for (const [index, example] of RENEWAL_CASES.entries()) {
      await observeCase(facts, example, index);
    }
    await observeJourney(facts);
    return facts;
  });
  facts.failedJoins = await failedJourneyFacts();
  return facts;
};

/* jscpd:ignore-start -- a list of strings, not code */
const firstLegs = { attempt: "normal:0", when: "after" };
const editedJourney = { phase: "edited" };
const foreignInvoice = { invoice: "in_currencies_away" };
const firstRead = { kind: "renewal", owner: "normal:0" };
/** A step starts from a named scenario, so each control keeps them all. */
const STEP_STATE = { scenarios: [] };
/** The invoices of the same attempt, and their ledger legs at both times. */
const ATTEMPT_LEGS = { invoices: ["attempt"], snapshots: ["attempt"] };
const FAULTS: Faults = {
  fields: [
    ["wrong-renewal-cash", "snapshots", "cashAmount", "", firstLegs],
    [
      "wrong-renewal-attendee",
      "snapshots",
      "cashDestination",
      "attendee:999999",
      firstLegs,
    ],
    [
      "wrong-renewal-listing",
      "snapshots",
      "saleDestination",
      "revenue:999999",
      firstLegs,
    ],
    ["wrong-renewal-paid-time", "snapshots", "cashPaidAt", "", firstLegs],
    ["duplicate-renewal-cash-leg", "snapshots", "cashCount", "", firstLegs],
    [
      "replaced-booking-accepted",
      "operations",
      "outcome",
      "returned",
      { scenario: "identity_attendee" },
    ],
    [
      "partial-renewal-status-commit",
      "operations",
      "afterStatus",
      "canceled",
      { attempt: "rollback:0" },
    ],
    [
      "wrong-exact-renewal-tax",
      "arithmetic",
      "observedTax",
      "",
      { caseId: "below_half" },
    ],
    [
      "foreign-renewal-currency-accepted",
      "invoices",
      "foreign",
      "",
      foreignInvoice,
    ],
    ["rewritten-joined-plan", "journeys", "price", "", editedJourney],
    ["wrong-joined-trial-time", "journeys", "trialAt", "", editedJourney],
    [
      "broken-failed-checkout-identity-join",
      "failedJoins",
      "observedSubscription",
      "sub_wrong_join",
      { attempt: "2" },
    ],
  ],
  missing: [
    [
      "missing-renewal-attempt",
      "initial",
      "operations",
      { attempt: "normal:0" },
    ],
    [
      "missing-renewal-arithmetic",
      "initial",
      "arithmetic",
      { caseId: "planned" },
    ],
    ["missing-renewal-currency", "initial", "expectedInvoices", foreignInvoice],
    ["missing-provider-read", "initial", "reads", firstRead],
    [
      "missing-renewal-scenario",
      "initial",
      "scenarios",
      { scenario: "normal" },
    ],
  ],
  reads: {
    arithmetic: STEP_STATE,
    failedJoins: STEP_STATE,
    invoices: { ...STEP_STATE, ...ATTEMPT_LEGS, operations: ["attempt"] },
    journeys: STEP_STATE,
    operations: { ...STEP_STATE, ...ATTEMPT_LEGS },
    reads: STEP_STATE,
    snapshots: { ...STEP_STATE, ...ATTEMPT_LEGS, operations: ["attempt"] },
  },
  whole: [
    [
      "wrong-renewal-subscription-read",
      "reads",
      "target",
      "sub_wrong_read",
      { kind: "renewal", owner: "normal:0" },
    ],
  ],
};
/* jscpd:ignore-end */

export const { controls, modelData } = producerFor(
  renewalFacts,
  renderRenewals,
  (facts) => facts,
  FAULTS,
  (changedData) => [
    {
      data: async () => renderRenewals(await renewalFacts("stored_vat")),
      name: "corrupt-stored-renewal-vat",
      phase: "step",
    },
    {
      data: changedData((facts) => {
        const first = requireValue(facts.reads[0], "Missing provider read");
        facts.reads.push({ ...first, ordinal: 1 });
      }),
      name: "duplicate-provider-read",
      phase: "initial",
    },
  ],
);
