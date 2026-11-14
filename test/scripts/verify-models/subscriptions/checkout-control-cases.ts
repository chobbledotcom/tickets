/** Independent business-field changes expected from every registered control. */
type FieldValues = Readonly<Record<string, string | number | boolean>>;

export type CheckoutControlCase = {
  name: string;
  table: string;
  target: FieldValues;
  before: FieldValues;
  /** The changed fields, or null when the control removes the fact. */
  after: FieldValues | null;
};

/** Each row names a control, its fact table, the field and value that select
 * its target, the target's clean fields, and its changed fields. The two
 * field lists are JSON text. */
/* jscpd:ignore-start -- a list of strings, not code */
const CASES: readonly (readonly [
  name: string,
  table: string,
  targetField: string,
  targetValue: string,
  before: string,
  after: string,
])[] = [
  [
    "unsupported-order-admitted",
    "AdmissionFacts",
    "scenario",
    "square-single",
    '{"checkoutAccepted":false,"orderAccepted":false}',
    '{"orderAccepted":true}',
  ],
  [
    "missing-refused-outcome",
    "AdmissionFacts",
    "scenario",
    "stripe-deposit",
    '{"checkoutAccepted":false,"orderAccepted":false}',
    "null",
  ],
  [
    "missing-booking-outcome",
    "PlanFacts",
    "identity",
    "checkout-1-stored-100",
    '{"attendee":14,"listing":11,"subscription":"sub_other_1"}',
    "null",
  ],
  [
    "wrong-booking-attribution",
    "PlanFacts",
    "identity",
    "checkout-1-stored-101",
    '{"attendee":14,"listing":12,"subscription":""}',
    '{"subscription":"sub_stolen"}',
  ],
  [
    "rewritten-plan-amount",
    "PlanFacts",
    "identity",
    "checkout-1-edited-105",
    '{"amount":1002}',
    '{"amount":1003}',
  ],
  [
    "wrong-plan-id",
    "PlanFacts",
    "identity",
    "checkout-1-edited-105",
    '{"subscription":"sub_model_1"}',
    '{"subscription":"sub_wrong"}',
  ],
  [
    "wrong-frozen-vat",
    "PlanFacts",
    "identity",
    "checkout-1-edited-105",
    '{"tax":0}',
    '{"tax":1}',
  ],
  [
    "wrong-plan-status",
    "PlanFacts",
    "identity",
    "checkout-1-edited-105",
    '{"status":"active"}',
    '{"status":"sub_wrong"}',
  ],
  [
    "wrong-plan-interval",
    "PlanFacts",
    "identity",
    "checkout-1-edited-105",
    '{"interval":"week"}',
    '{"interval":"sub_wrong"}',
  ],
  [
    "wrong-first-invoice-reference",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"paymentReference":"pi_first_1"}',
    '{"paymentReference":"wrong"}',
  ],
  [
    "wrong-request-listing",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"metadataListing":11}',
    '{"metadataListing":12}',
  ],
  [
    "wrong-recurring-amount",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"recurringAmount":1002}',
    '{"recurringAmount":1003}',
  ],
  [
    "wrong-recurring-time",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"trialEnd":1799057700}',
    '{"trialEnd":1799057701}',
  ],
  [
    "wrong-recurring-interval",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"interval":"week"}',
    '{"interval":"wrong"}',
  ],
  [
    "wrong-initial-amount",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"oneTimeAmount":2137}',
    '{"oneTimeAmount":2138}',
  ],
  [
    "wrong-invoice-read",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"invoiceRead":"in_first_1"}',
    '{"invoiceRead":"wrong"}',
  ],
  [
    "wrong-subscription-read",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"subscriptionRead":"sub_model_1"}',
    '{"subscriptionRead":"wrong"}',
  ],
  [
    "extra-recurring-line",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"recurringLines":1}',
    '{"recurringLines":2}',
  ],
  [
    "wrong-recurring-quantity",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"recurringQuantity":1}',
    '{"recurringQuantity":2}',
  ],
  [
    "missing-one-time-line",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"oneTimeLines":2}',
    '{"oneTimeLines":3}',
  ],
  [
    "wrong-subscribed-initial-line",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"subscribedInitial":2000}',
    '{"subscribedInitial":2001}',
  ],
  [
    "wrong-ordinary-initial-line",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"ordinaryInitial":137}',
    '{"ordinaryInitial":138}',
  ],
  [
    "wrong-initial-quantity",
    "RequestFacts",
    "scenario",
    "checkout-1",
    '{"initialQuantity":2}',
    '{"initialQuantity":3}',
  ],
];
/* jscpd:ignore-end */

export const checkoutControlCases: readonly CheckoutControlCase[] = CASES.map(
  ([name, table, targetField, targetValue, before, after]) => ({
    after: JSON.parse(after),
    before: JSON.parse(before),
    name,
    table,
    target: { [targetField]: targetValue },
  }),
);
