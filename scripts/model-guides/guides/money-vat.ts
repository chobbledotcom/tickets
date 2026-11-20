import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** A later VAT setting must not rewrite a saved sale. */
/* jscpd:ignore-start -- static data, not code */
export const vatLedger: ModelGuide = {
  badOutcome:
    "A later VAT setting rewrites a past refunded sale, or a stale form saves over the current assessment.",
  cast: [
    {
      meaning:
        "One booking with a saved tax assessment. The model labels the sale active or refunded.",
      term: "sale",
    },
    {
      meaning:
        "The fixed listed amounts and adjustments for the sale, in minor units.",
      term: "basis",
    },
    {
      meaning:
        "The VAT policy that a save applies now. A setting is not part of the sale.",
      term: "setting",
    },
    {
      meaning:
        "No tax, tax added to the price, or tax within the price. Rates use basis points.",
      term: "policy",
    },
    {
      meaning:
        "A version count on the sale. A stale form carries an old revision.",
      term: "revision",
    },
    {
      meaning:
        "One prepared event result with true or false checks. It is not a live customer record.",
      term: "attempt",
    },
  ],
  claim:
    "This page follows one booking's saved tax assessment. A settings change alone does not rewrite a recorded sale. An accepted save uses the setting at that moment. A refund keeps the recorded amounts and closes the sale.",
  limits: [
    "The examples use four small bases, seven policies, and revisions zero and two.",
    "They do not prove every price, every production input, or a concurrent save.",
    "SQL atomicity, provider truth, eventual completion, and legal VAT compliance need separate tests.",
    "The model checks safety. It does not prove that a save or refund eventually occurs.",
  ],
  module: "VatLedger",
  safety:
    "Every accepted event keeps the recorded basis. A save uses the current setting. A save changes the revision only on an active sale with a new policy. An accepted refund changes it only on an active sale. A refusal changes nothing. A refunded sale stays refunded.",
  steps: [
    {
      code: [
        {
          path: "src/shared/tax/assessment.ts",
          symbol: "assessTax",
        },
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "TAX_BASES",
        },
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "validVatAssessment",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with an active sale",
      values: [
        { name: "bookingState", value: "active" },
        { name: "allAttemptsSafe", value: "TRUE" },
        { name: "initial samples", value: "784" },
        {
          name: "basis half",
          value: "One line with gross 3. Policy none gives tax 0 and total 3.",
        },
      ],
      what: "The model starts with one active sale. It also checks every generated initial assessment, including samples for the refunded label. The producer builds those samples from the same small bases and policies.",
    },
    {
      code: [
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "TAX_EVENTS",
        },
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "TAX_POLICIES",
        },
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "taxNodeOf",
        },
      ],
      rules: ["VatStep", "Next"],
      title: "A new setting does not touch the sale",
      values: [
        { name: "event", value: "setting_add" },
        {
          name: "setting",
          value: "none changes to add_to_total at 2000 basis points",
        },
        { name: "assessment policy", value: "none, unchanged" },
        { name: "revision", value: "0" },
      ],
      what: "The setting_add event replaces the setting and leaves the sale alone. The assessment still holds the no-tax policy. The model joins the event to the active state through taxNodeOf. Next also permits a pause.",
    },
    {
      code: [
        {
          path: "src/shared/tax/assessment.ts",
          symbol: "assessTax",
        },
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "vatModel",
        },
      ],
      rules: ["VatStep"],
      title: "An accepted save applies the current setting",
      values: [
        { name: "basis", value: "One line with gross 3" },
        { name: "setting", value: "add_to_total at 2000 basis points" },
        { name: "taxAmount", value: "1" },
        { name: "total", value: "4" },
        { name: "revision", value: "0 changes to 1" },
      ],
      what: "The save event calls reassessTax with the current setting. The producer expects assessTax on the saved basis with that setting. The tax is one minor unit because half units round up. The revision changes because the policy differs from the recorded policy.",
    },
    {
      code: [
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "TAX_EVENTS",
        },
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "vatModel",
        },
      ],
      rules: ["VatStep"],
      title: "A stale form is refused",
      values: [
        { name: "form revision", value: "0" },
        { name: "stored revision", value: "1" },
        { name: "expected revision", value: "revision minus one, which is 0" },
        { name: "accepted", value: "FALSE" },
        { name: "assessment", value: "unchanged" },
      ],
      what: "The save_stale event supplies an old revision on purpose. reassessTax refuses it and throws. The producer records accepted FALSE and keeps the old assessment. The model treats this refusal as a legal attempt, not a crash.",
    },
    {
      code: [
        {
          path: "src/shared/tax/machine-spec.ts",
          symbol: "TAX_EVENTS",
        },
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "vatModel",
        },
      ],
      rules: ["VatStep"],
      title: "A refund closes the sale and keeps its amounts",
      values: [
        { name: "bookingState", value: "active changes to refunded" },
        { name: "revision", value: "1 changes to 2" },
        { name: "basis", value: "unchanged" },
        { name: "taxAmount", value: "1" },
        {
          name: "second refund",
          value: "accepted, refunded stays refunded, revision 2 stays 2",
        },
      ],
      what: "An accepted refund changes the label to refunded and keeps the assessment. The revision rises by one. A refunded sale stays refunded, so a later refund leaves the label and revision unchanged. A later setting event cannot rewrite the amounts.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "validVatAssessment",
        },
        {
          path: "scripts/verify-models/vat.ts",
          symbol: "corruptVatData",
        },
      ],
      rules: ["SafeAttempt", "Safety", "VatStep"],
      title: "Safety joins the promises",
      values: [
        {
          name: "safe attempt",
          value: "All nine checks are TRUE. allAttemptsSafe stays TRUE.",
        },
        {
          name: "bad setting event",
          value: "The setting rewrites the sale. assessmentCorrect is FALSE.",
        },
        { name: "bad run", value: "allAttemptsSafe becomes FALSE" },
      ],
      what: "SafeAttempt requires nine checks: arithmetic, basis, setting, revision, assessment, terminal label, refusal, no provider call, and the combined verdict. VatStep applies any prepared attempt and keeps a false verdict. Safety requires every check to pass.",
    },
  ],
  title: "Keeping a saved VAT assessment stable across settings and refunds",
};
/* jscpd:ignore-end */
