import type { ModelGuide } from "#scripts/model-guides/types.ts";

const SETTLED_ORDER = "src/features/api/payment-processing/settled-order.ts";
const PRODUCER = "scripts/verify-models/sealed-order.ts";

/** The everyday story of a sealed checkout order. */
/* jscpd:ignore-start -- static data, not code */
export const sealedOrder: ModelGuide = {
  badOutcome:
    "A late callback books a second ticket, a ticket comes from a receipt with no buyer, a booked session raises the lost-order alarm, or a lost order is refunded.",
  cast: [
    {
      meaning:
        "The whole order of a Stripe or Square checkout, kept in our database. Only the payment provider holds the token that opens it.",
      term: "sealed order",
    },
    {
      meaning:
        "The copy that a settled session keeps in place of its order. It holds the lines and the thank-you link, and no personal details.",
      term: "receipt",
    },
    {
      meaning:
        "One provider callback, or one visit of the buyer to the return page. Both read the order and give the same answer.",
      term: "delivery",
    },
    {
      meaning:
        "The temporary payment row. none is absent, reserved is an unresolved reservation, finalized holds a booking, and failed holds a final handled outcome.",
      term: "row",
    },
    {
      meaning:
        "The durable record of money. recorded means at least one leg for the session. A booking and a refunded placeholder both write legs.",
      term: "ledger",
    },
    {
      meaning:
        "A session whose row holds a final result, or whose ledger holds a leg.",
      term: "settled",
    },
    {
      meaning:
        "One prepared delivery outcome from the producer. It is not an observed callback or SQL race.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one sealed order through callbacks, return visits, the receipt, the prune, and row loss, in any order. The session makes at most one ticket, never from a receipt. A settled session never raises the lost-order alarm. A lost order is never refunded.",
  limits: [
    "The model uses one session, three bundle states, four row states, and two ledger labels.",
    "It assumes the atomic booking batch. It does not prove SQL atomicity or row locks.",
    "A delivery that finds a reserved row and a pruned order raises the alarm, because that session is not settled yet.",
    "It does not prove that a callback, a receipt write, or a prune ever happens.",
  ],
  module: "SealedOrder",
  safety:
    "Every allowed state has ledger legs for a ticket, a final row, and a receipt. Every delivery so far kept the alarm for sessions that are not settled, refunded no lost order, and made no ticket from a receipt.",
  steps: [
    {
      code: [
        {
          path: "src/shared/db/checkout-bundles.ts",
          symbol: "sealCheckoutBundle",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start after checkout",
      values: [
        { name: "bundle", value: "order" },
        { name: "row", value: "none" },
        { name: "ledger", value: "unrecorded" },
        { name: "tickets", value: "0" },
      ],
      what: "Checkout seals the whole order before the buyer goes to the provider. No delivery has arrived, so there is no row and no ledger leg.",
    },
    {
      code: [
        {
          path: "src/features/api/payment-processing/index.ts",
          symbol: "processPaymentSession",
        },
      ],
      rules: ["ReserveStep", "SettleBooked", "SettleFailed", "ReleaseReserved"],
      title: "The first delivery reserves the row and settles it",
      values: [
        { name: "row", value: "none, then reserved, then finalized or failed" },
        { name: "ledger after", value: "recorded" },
        { name: "tickets after a booking", value: "1" },
      ],
      what: "A delivery that reads the order reserves the row. It then books, or ends with a refunded placeholder. Both write ledger legs in one batch. A retryable failure releases the row and keeps the whole order for the provider's retry.",
    },
    {
      code: [
        { path: SETTLED_ORDER, symbol: "keepOrderReceipt" },
        {
          path: "src/shared/db/checkout-bundles.ts",
          symbol: "rewriteCheckoutBundle",
        },
        { path: PRODUCER, symbol: "earlyReceiptData" },
      ],
      rules: ["KeepReceipt", "FinalRows", "ReceiptOnlyWhenRecorded"],
      title: "A settled session keeps only a receipt",
      values: [
        { name: "row before", value: "finalized or failed" },
        { name: "bundle before", value: "order" },
        { name: "bundle after", value: "receipt" },
      ],
      what: "After the outcome, a separate write replaces the order with a receipt. A crash can leave the order in place, and a replay of the final row then writes the receipt again. The early-receipt control also writes a receipt on an open row, and the checker finds a receipt with no ledger leg.",
    },
    {
      code: [
        {
          path: "src/shared/db/checkout-bundles.ts",
          symbol: "CHECKOUT_BUNDLE_RETENTION_MS",
        },
      ],
      rules: ["PruneBundle", "DeleteRow", "RowGoes"],
      title: "The sealed row and the payment row can disappear",
      values: [
        { name: "prune", value: "order or receipt becomes gone" },
        { name: "retention", value: "finalized or failed becomes none" },
        { name: "ledger", value: "unchanged" },
      ],
      what: "The prune deletes the sealed row after the checkout and retry windows. Retention deletes a final payment row later. The model lets both happen at any time. The ledger keeps its legs.",
    },
    {
      code: [
        {
          path: "src/features/api/payment-processing/classify.ts",
          symbol: "classifySessionIntent",
        },
        { path: SETTLED_ORDER, symbol: "sessionStanding" },
        { path: PRODUCER, symbol: "settledAlarmData" },
        { path: PRODUCER, symbol: "lostOrderRefundData" },
      ],
      rules: [
        "DeliveryStep",
        "Settled",
        "AlarmsWhenSettled",
        "RefundsLostOrder",
      ],
      title: "A delivery with no order asks whether the session is settled",
      values: [
        { name: "bundle", value: "gone" },
        { name: "settled", value: "answer settled, no alarm" },
        { name: "not settled", value: "alarm, retry, no refund" },
      ],
      what: "A delivery that finds no readable order checks the row and the ledger. A settled session answers as settled. Any other session raises the alarm and refuses retryably, with no refund. The settled-alarm control raises the alarm for every missing order. The refund control refunds the lost orders. The checker rejects both.",
    },
    {
      code: [
        { path: PRODUCER, symbol: "sealedOrderModelData" },
        {
          path: "src/features/api/payment-processing/index.ts",
          symbol: "processPaymentSession",
        },
      ],
      rules: ["BooksFromReceipt", "LedgerMatchesSettlement"],
      title: "A readable order replays from the row or the ledger",
      values: [
        { name: "reserved row", value: "held" },
        { name: "final row", value: "replay" },
        { name: "no row, recorded ledger", value: "replay and heal the row" },
      ],
      what: "A delivery that reads an order or a receipt answers held for a reserved row and replays a final row. With no row and a recorded ledger, it replays from the ledger. A receipt exists only after ledger legs, so the fact that books from a receipt can never apply.",
    },
    {
      code: [{ path: PRODUCER, symbol: "sealedOrderModelData" }],
      rules: ["Next", "Safety"],
      title: "Safety joins the relations and the verdicts",
      values: [
        { name: "ticket or final row", value: "needs a ledger leg" },
        { name: "receipt", value: "needs a ledger leg" },
        { name: "verdicts", value: "three flags that stay TRUE" },
      ],
      what: "Safety joins TypeOK, the three kept verdicts, and the two state relations. Next permits a delivery, the reserve, either settle, the release, the receipt, the prune, the row deletion, or no change.",
    },
  ],
  title: "A sealed checkout order books once and never raises a false alarm",
};
/* jscpd:ignore-end */
