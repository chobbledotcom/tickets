/** Real renewal writes, stored observations, and independently checkable inputs. */

import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { stripeApi } from "#shared/stripe.ts";
import { type Faults, producerFor } from "./controls.ts";
import { paidInvoice, withSubscriptionDb } from "./environment.ts";
import { failedJourneyFacts, observeJourney } from "./journey.ts";
import { arithmeticFacts, RENEWAL_CASES } from "./renewal-cases.ts";
import { type RenewalFacts, renderRenewals } from "./renewal-facts.ts";
import { captureRead, observeCase } from "./renewal-observations.ts";

const currencyFacts = async (): Promise<
  Pick<RenewalFacts, "currencies" | "reads">
> => {
  const currency = settings.currency.toLowerCase();
  const client = stripeClientRuntime.create("sk_test_model_currency");
  const previous = stripeClientRuntime.get;
  const answers = [
    { caseId: "site_currency", currencies: [currency] },
    { caseId: "foreign_currency", currencies: ["model_foreign"] },
    { caseId: "mixed_currency", currencies: [currency, "model_foreign"] },
  ];
  const facts: RenewalFacts["currencies"] = [];
  const reads: RenewalFacts["reads"] = [];
  stripeClientRuntime.get = () => Promise.resolve(client);
  try {
    for (const example of answers) {
      client.invoices.listPaid = captureRead(
        reads,
        "currency",
        example.caseId,
        () =>
          Promise.resolve(
            example.currencies.map((value, index) => ({
              ...paidInvoice(`in_currency_${index}`),
              currency: value,
            })),
          ),
      );
      const answer = await stripeApi.readPaidInvoices("sub_currency");
      facts.push({
        allMatch: example.currencies.every((value) => value === currency),
        caseId: example.caseId,
        status: answer.status,
      });
    }
  } finally {
    stripeClientRuntime.get = previous;
  }
  return { currencies: facts, reads };
};

/** Every invocation observes a fresh database; fault tests cannot read cached facts. */
export const renewalFacts = async (
  corruption: "none" | "stored_vat" = "none",
): Promise<RenewalFacts> => {
  const facts = await withSubscriptionDb(async () => {
    const facts: RenewalFacts = {
      arithmetic: arithmeticFacts(),
      ...(await currencyFacts()),
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
      scenarios: [],
      snapshots: [],
    };
    if (corruption === "stored_vat")
      await execute(
        `CREATE TRIGGER model_corrupt_renewal_vat AFTER INSERT ON transfers
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
const siteCurrencyRead = { kind: "currency", owner: "site_currency" };
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
      "currencies",
      "status",
      "found",
      { caseId: "foreign_currency" },
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
    [
      "wrong-renewal-subscription-read",
      "reads",
      "target",
      "sub_wrong_read",
      { kind: "renewal", owner: "normal:0" },
    ],
    [
      "wrong-invoice-list-subscription",
      "reads",
      "target",
      "sub_wrong_read",
      siteCurrencyRead,
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
    [
      "missing-renewal-currency",
      "initial",
      "currencies",
      { caseId: "site_currency" },
    ],
    ["missing-provider-read", "initial", "reads", siteCurrencyRead],
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
