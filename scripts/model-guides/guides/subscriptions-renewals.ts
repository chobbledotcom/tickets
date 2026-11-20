import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of one paid renewal that reaches the ledger. */
/* jscpd:ignore-start -- static data, not code */
export const subscriptionRenewals: ModelGuide = {
  badOutcome:
    "A renewal posts money to the wrong attendee or listing, or a replay adds a second copy of one invoice.",
  cast: [
    {
      meaning:
        "One stored row that links an attendee to a listing and holds the subscription plan.",
      term: "booking row",
    },
    {
      meaning:
        "The recurring amount and the VAT inside it, frozen at checkout. Amounts are integer minor units.",
      term: "plan",
    },
    {
      meaning:
        "One paid charge from Stripe. A cycle invoice for a later period is a renewal.",
      term: "invoice",
    },
    {
      meaning:
        "One transfer row with a source account, a destination account, an amount, and a reference.",
      term: "ledger leg",
    },
    {
      meaning:
        "One observed call for one attempt. The producer reads the ledger before and after the call.",
      term: "pass",
    },
    {
      meaning:
        "An invoice with reason subscription_cycle and an amount above zero.",
      term: "eligible invoice",
    },
    {
      meaning:
        "The four stored values that name the booking: row id, attendee, listing, and subscription.",
      term: "fence",
    },
  ],
  claim:
    "This page follows one Stripe renewal report into the ledger. A paid cycle invoice posts its cash, sale, and VAT roles for the right attendee and listing. A replay leaves those same legs in place. A changed booking identity posts no money.",
  limits: [
    "The examples use a month plan of 600 with 100 VAT, 100 invoices in one case, and all eight statuses.",
    "Provider replies are synthetic assumptions. The model does not prove provider truth.",
    "The model reads committed legs before and after each pass. It does not prove SQL atomicity or rollback.",
    "The model checks safety. It does not prove that a retry runs or that work finishes.",
    "Invoices older than the newest 100 and later manual collection need separate tests.",
    "The arithmetic cases check local integer math. They do not prove that Stripe accepts a large charge.",
  ],
  module: "SubscriptionRenewals",
  safety:
    "Every invoice role matches its expected amount. A positive role has exactly one leg with the right account, reference, and paid time. A zero role has no leg. Cash equals sale plus VAT. A refused call leaves every stored leg unchanged.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/renewal-cases.ts",
          symbol: "RENEWAL_CASES",
        },
        {
          detail: "declaration",
          path: "src/shared/subscriptions/plan.ts",
          symbol: "SubscriptionStatusSchema",
        },
      ],
      rules: [
        "Init",
        "TypeOK",
        "Statuses",
        "ScenarioNames",
        "ExpectedScenarioNames",
      ],
      title: "Start before the first pass",
      values: [
        { name: "scenario", value: "normal" },
        { name: "passIndex", value: "0" },
        { name: "storedStatus", value: "trialing" },
        { name: "checksHold", value: "TRUE" },
        { name: "arithmeticChecked", value: "FALSE" },
      ],
      what: "The model starts before the first observed pass of one scenario. The fixture has a plan and no renewal legs. The fixture seeds a trialing plan. The stale_status scenario replaces that status with canceled before its first pass. Statuses adds a blank word for a booking that a merge removed. ScenarioNames and ExpectedScenarioNames must agree before a pass can run.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/renewal-facts.ts",
          symbol: "renderRenewals",
        },
        {
          path: "scripts/verify-models/subscriptions/renewal-observations.ts",
          symbol: "captureRead",
        },
        { path: "src/shared/stripe.ts", symbol: "stripeApi" },
      ],
      rules: [
        "Coverage",
        "CurrencyCases",
        "ArithmeticCases",
        "RequiredReads",
        "ReadCoverage",
        "ReadIdentitySafe",
      ],
      title: "Every declared input needs one result",
      values: [
        { name: "scenarios", value: "18" },
        { name: "passes", value: "21" },
        { name: "captured reads", value: "24" },
        { name: "currency cases", value: "site, foreign, and mixed" },
        { name: "arithmetic cases", value: "11" },
      ],
      what: "Coverage requires one observed result for each declared input. The inputs come before the calls. The producer declares 18 scenario names and 21 passes. Each pass has one renewal read. Each of the 3 currency cases has one read at the Stripe client, which makes 24 reads. The producer keeps every read argument, so a repeated call with equal arguments stays visible. A renewal read must name the subscription of its attempt. A currency read must name sub_currency.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/renewal-observations.ts",
          symbol: "observePass",
        },
        {
          path: "src/shared/subscriptions/record.ts",
          symbol: "recordObserved",
        },
      ],
      rules: ["InspectPass", "AttemptSafe", "ExpectedOutcome"],
      title: "One pass writes or refuses",
      values: [
        { name: "read", value: "found" },
        { name: "outcome", value: "returned" },
        { name: "refused read", value: "missing. The outcome is returned." },
        {
          name: "after a refusal",
          value: "The status and every leg stay the same.",
        },
      ],
      what: "One pass runs the producer call for one attempt. The pass reads the ledger legs before and after the call. A refused read returns without a write. A refused write keeps both the status and every leg. A successful call checks each eligible invoice and leaves other invoices alone. An attempt with no eligible invoice posts no renewal legs.",
    },
    {
      code: [
        { path: "src/shared/accounting/mappers.ts", symbol: "mapRenewal" },
        { path: "src/shared/subscriptions/plan.ts", symbol: "renewalTax" },
        { path: "src/shared/tax/assessment.ts", symbol: "roundedRatio" },
        {
          path: "src/shared/accounting/store.ts",
          symbol: "postTransferGroups",
        },
      ],
      rules: [
        "TaxShare",
        "RoleSafe",
        "LegsSafe",
        "LegsBefore",
        "LegsAfter",
        "Eligible",
      ],
      title: "Cash, sale, and VAT reach the right accounts",
      values: [
        { name: "invoice", value: "600 with price 600 and tax 100" },
        { name: "cash leg", value: "600 from external:world to the attendee" },
        {
          name: "sale leg",
          value: "500 from the attendee to the listing revenue account",
        },
        { name: "VAT leg", value: "100 from the attendee to tax:vat" },
        { name: "zero role", value: "No leg and no account." },
      ],
      what: "A paid cycle invoice posts three legs. Cash moves from external:world to the attendee. Sale moves the amount without VAT from the attendee to the listing revenue account. VAT moves to tax:vat. The law checks each role before the sum. A role with expected amount zero needs no leg. A positive role needs exactly one leg with the right account, reference, and paid time. Cash must equal sale plus VAT.",
    },
    {
      code: [
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "renewalBookingGuard",
        },
        { path: "src/shared/db/subscriptions.ts", symbol: "statusWrite" },
        {
          path: "src/shared/subscriptions/record.ts",
          symbol: "recordObserved",
        },
      ],
      rules: ["HasEligible", "FenceHeld", "Conflicts", "ExpectedStatus"],
      title:
        "A changed booking or a replay with different facts posts no money",
      values: [
        { name: "identity_attendee", value: "outcome booking_fence" },
        {
          name: "conflict",
          value: "first pass 600, second pass 601, outcome ledger_conflict",
        },
        {
          name: "stale status",
          value: "before trialing, observed past_due, after past_due",
        },
        { name: "ended observation", value: "A live row becomes ended." },
      ],
      what: "A merge can replace the booking while Stripe answers. The fence compares the read row id, attendee, listing, and subscription with the stored row. A mismatch refuses the whole call. A replay of an invoice that already holds money must match the new facts exactly. A mismatch returns ledger_conflict and rewrites no old leg. The status rule lets an ended status replace a live one. A live status replaces only the status that the caller read, so an earlier cancel stays.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/journey.ts",
          symbol: "observeJourney",
        },
        {
          path: "scripts/verify-models/subscriptions/journey.ts",
          symbol: "failedJourneyFacts",
        },
      ],
      rules: ["JoinCoverage", "JourneyLaw", "FailedJoinLaw"],
      title: "The plan and the failed checkout keep their identities",
      values: [
        { name: "plan phases", value: "stored, edited, renewed, cancelled" },
        { name: "plan", value: "1002 net, 200 VAT, 1202 total" },
        { name: "failed deliveries", value: "3" },
        { name: "delivery 1", value: "held 1, refunds 0, authority 0" },
        { name: "delivery 2", value: "confirmed, refunds 1, cash 600" },
        { name: "delivery 3", value: "refunds 1. No second provider refund." },
      ],
      what: "JoinCoverage requires four plan phases and three failed checkout deliveries. JourneyLaw keeps one real checkout row through a stored phase, a plan edit, a renewal, and an owner cancel. A listing price edit and a tax edit cannot change the stored plan. The plan holds 1002 net plus 200 VAT, which is a total of 1202. FailedJoinLaw keeps a zero-quantity failed checkout across three deliveries. Delivery one holds the payment anchor and sends no refund. Delivery two ends Stripe and refunds 600 once. Delivery three repeats the stored work and keeps one refund.",
    },
    {
      code: [
        { path: "src/shared/tax/assessment.ts", symbol: "roundedRatio" },
        {
          path: "scripts/verify-models/subscriptions/renewal-observations.ts",
          symbol: "captureRead",
        },
      ],
      rules: ["InspectArithmetic", "InspectJoins", "InspectReads"],
      title: "Independent checks do not trust the pass order",
      values: [
        { name: "303 of 600 at 100", value: "51 VAT" },
        { name: "900 of 600 at 100", value: "150 VAT" },
        { name: "1 of price 2 at tax 1", value: "1 VAT" },
        {
          name: "checksHold",
          value: "Stays TRUE only when every check passes.",
        },
      ],
      what: "Three separate checks do not depend on the pass order. InspectArithmetic compares every arithmetic fact with TaxShare and every currency fact with its read result. InspectJoins rechecks both joins. InspectReads rechecks every captured read identity. Each check keeps an earlier failure visible in checksHold.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/renewals.ts",
          symbol: "renewalFacts",
        },
        { path: "src/shared/accounting/store.ts", symbol: "postTransfersTx" },
      ],
      rules: ["Safety", "Next"],
      title: "Safety covers every pass and every refusal",
      values: [
        { name: "passIndex", value: "2" },
        { name: "checksHold", value: "TRUE" },
        {
          name: "Next",
          value:
            "A pass, an arithmetic check, a join check, a read check, or no change.",
        },
      ],
      what: "Safety joins the type bounds with the memory of every failed law. The initial state sets checksHold from Coverage and JoinCoverage, so a missing fact fails at once. Next permits one pass, one arithmetic check, one join check, one read check, or no change. No fairness rule requires a retry, and the model does not prove that work finishes.",
    },
  ],
  title: "One paid renewal reaches the ledger with cash, sale, and VAT legs",
};
/* jscpd:ignore-end */
