import type { ModelGuide } from "#scripts/model-guides/types.ts";
/** The everyday story of one attendee's invoice. */
/* jscpd:ignore-start -- static data, not code */
export const invoiceFlow: ModelGuide = {
  badOutcome:
    "Two open invoices for one attendee, a closed invoice that returns to open, or a status that does not match the action that caused it.",
  cast: [
    {
      meaning:
        "The customer record that holds the booked places and owes the invoice.",
      term: "attendee",
    },
    {
      meaning:
        "One bill for one attendee. It has an invoice number, a status, and a frozen rendered body.",
      term: "invoice",
    },
    {
      meaning:
        "The operator-visible identity of an invoice. The examples use numbers 1 and 2 for one attendee.",
      term: "invoice number",
    },
    {
      meaning: "An invoice with status new. It is not yet cancelled or paid.",
      term: "open invoice",
    },
    {
      meaning: "An invoice with status cancelled or paid.",
      term: "closed invoice",
    },
    {
      meaning: "One create, cancel, or settle action on one invoice number.",
      term: "attempt",
    },
    {
      meaning:
        "The result of one production statement on a fresh copy of the invoice table. It is not a live row.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one attendee with two invoice numbers. Every reachable state keeps at most one open invoice. Every accepted action reaches its own status, and no action changes the other invoice number.",
  limits: [
    "The examples use one attendee and two invoice numbers. They do not prove every number, every amount, or a ledger balance that a later charge changes.",
    "One step applies one fact. The model does not prove a concurrent create, a batch of actions, or SQL rollback.",
    "A delete removes the row, so the model shows an absent number and gives the delete no separate step.",
    "The model checks safety. It does not prove that an invoice eventually closes, that a provider accepts a payment, or that a share link delivers the body.",
  ],
  module: "InvoiceFlow",
  safety:
    "Every reachable state has at most one invoice with status new. Every applied fact agrees with its guard, reaches its own target status, and keeps the other invoice number unchanged.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/invoice-flow.ts",
          symbol: "invoiceFlowModelData",
        },
        {
          path: "src/shared/db/migrations/schema/tables-invoices.ts",
          symbol: "invoiceTables",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with no invoice",
      values: [
        { name: "firstInvoice", value: "absent" },
        { name: "secondInvoice", value: "absent" },
        { name: "allAttemptsSafe", value: "TRUE" },
        { name: "OpenCount", value: "0" },
      ],
      what: "The model starts with no row at invoice number 1 and no row at number 2. A real attendee can start with a closed invoice, and the facts supply that case as a step. TypeOK limits each status to absent, new, cancelled, or paid. The invoice table supplies the status column and the unique partial index that the facts exercise.",
    },
    {
      code: [
        { path: "src/shared/db/invoices.ts", symbol: "createInvoice" },
        {
          path: "src/shared/db/migrations/schema/tables-invoices.ts",
          symbol: "invoiceTables",
        },
      ],
      rules: ["AttemptStep", "SafeAttempt", "IsOpen", "OpenCount"],
      title: "Create invoice 1",
      values: [
        { name: "action", value: "create invoice 1" },
        { name: "statusBefore", value: "absent" },
        { name: "otherNew", value: "FALSE" },
        { name: "accepted", value: "TRUE" },
        { name: "statusAfter", value: "new" },
        { name: "firstInvoice", value: "new" },
        { name: "secondInvoice", value: "absent" },
        { name: "OpenCount", value: "1" },
      ],
      what: "The create form stores the row with status new. The unique partial index allows the row because this attendee has no open invoice. The fact records the accepted action and the target status new. AttemptStep writes new to the first number and leaves the second number absent. IsOpen reads new as open, so the open count becomes one.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/invoice-flow.ts",
          symbol: "isOpenInvoiceRefusal",
        },
        {
          path: "src/shared/db/migrations/schema/tables-invoices.ts",
          symbol: "invoiceTables",
        },
      ],
      rules: [
        "AttemptStep",
        "SafeAttempt",
        "StatusAt",
        "StatusElsewhere",
        "IsOpen",
        "OpenCount",
      ],
      title: "Refuse a second open invoice",
      values: [
        { name: "action", value: "create invoice 2" },
        { name: "statusBefore", value: "absent" },
        { name: "otherNew", value: "TRUE" },
        { name: "accepted", value: "FALSE" },
        { name: "statusAfter", value: "absent" },
        { name: "secondInvoice", value: "absent" },
        { name: "OpenCount", value: "1" },
      ],
      what: "Invoice 1 is still new. The insert for invoice 2 fails the partial unique index on the attendee. The producer recognises that failure as the open-invoice refusal and records a refused fact. StatusAt reads the number that the attempt names, and StatusElsewhere supplies the open invoice 1 to the create guard. The step keeps the absent status at number 2 and the open count stays one.",
    },
    {
      code: [
        {
          path: "src/shared/db/invoices.ts",
          symbol: "cancelInvoiceStatement",
        },
      ],
      rules: ["AttemptStep", "SafeAttempt", "StatusAt", "OpenCount"],
      title: "Cancel the open invoice",
      values: [
        { name: "action", value: "cancel invoice 1" },
        { name: "statusBefore", value: "new" },
        { name: "accepted", value: "TRUE" },
        { name: "statusAfter", value: "cancelled" },
        { name: "OpenCount", value: "0" },
      ],
      what: "The cancel statement moves one row from new to cancelled and matches no other row. The fact accepts the action because the stored status is new. StatusAt gives the current status at number 1. AttemptStep writes cancelled to that number, and SafeAttempt checks the target and the unchanged number 2. The open count falls to zero.",
    },
    {
      code: [{ path: "src/shared/db/invoices.ts", symbol: "createInvoice" }],
      rules: [
        "AttemptStep",
        "SafeAttempt",
        "IsOpen",
        "StatusElsewhere",
        "OpenCount",
      ],
      title: "Create invoice 2 after the cancel",
      values: [
        { name: "action", value: "create invoice 2" },
        { name: "statusBefore", value: "absent" },
        { name: "otherNew", value: "FALSE" },
        { name: "accepted", value: "TRUE" },
        { name: "statusAfter", value: "new" },
        { name: "firstInvoice", value: "cancelled" },
        { name: "secondInvoice", value: "new" },
        { name: "OpenCount", value: "1" },
      ],
      what: "Number 1 is now cancelled. The create guard sees no open invoice on the other number, so the insert lands with status new. The fact matches the current absent status at number 2. AttemptStep writes new there and leaves number 1 cancelled. The open count returns to one, never two.",
    },
    {
      code: [
        {
          path: "src/shared/db/invoices.ts",
          symbol: "markOpenInvoicesPaidStatement",
        },
        {
          path: "scripts/verify-models/invoice-flow.ts",
          symbol: "invoiceFlowModelData",
        },
      ],
      rules: ["Next", "Safety", "TypeOK", "OpenCount", "SafeAttempt"],
      title: "Settle or pause, and keep the law",
      values: [
        {
          name: "accepted settle",
          value: "The guard matches. The open invoice becomes paid.",
        },
        {
          name: "refused settle",
          value: "The guard does not match. The invoice stays new.",
        },
        { name: "pause", value: "Every value stays the same." },
        { name: "result", value: "At most one open invoice." },
      ],
      what: "The settle statement marks the attendee's open invoices paid only when the ledger balance equals the amount that the settle clears. A matched guard closes the invoice. An unmatched guard leaves it open. The next-state relation also permits a pause with no change. Safety joins TypeOK, the open count at most one, and every retained verdict. A failed fact stays visible after a later good fact, so a good step cannot hide it.",
    },
  ],
  title: "Create, cancel, and settle one attendee's invoice",
};

/** The everyday story of two recoveries that share one attendee's flags. */
export const notificationFlagLease: ModelGuide = {
  badOutcome:
    "A recovery clears an owed send and loses its origin, or two recoveries both claim the same work.",
  cast: [
    {
      meaning: "The customer record that holds a buyer's booked places.",
      term: "attendee",
    },
    {
      meaning:
        "One message that the application owes after a booking. Email and webhooks are separate sides.",
      term: "notification",
    },
    {
      meaning:
        "A small stored integer on the attendee. A positive value says a send is still due. Zero says no stored debt.",
      term: "flag",
    },
    {
      meaning:
        "The origin that a positive flag records. Colour 1 is online and shows red. Colour 2 is admin-added and shows orange.",
      term: "colour",
    },
    {
      meaning:
        "The model memory of work that a claim reserved. A claim sets the stored flags to zero and remembers their colours. The application stores no lease row.",
      term: "lease",
    },
    {
      meaning:
        "The exact flag colour that a claim read. A restore must write this value back.",
      term: "capture",
    },
    {
      meaning: "One recovery caller. The examples use w1 and w2.",
      term: "worker",
    },
    {
      meaning:
        "The result of one production statement. It is not a live database event.",
      term: "fact",
    },
  ],
  claim:
    "This page follows two recoveries on one attendee. A claim reserves each positive flag and remembers its colour. A restore writes that exact colour back. A clear removes the debt only after an external send accepts.",
  limits: [
    "The examples use one attendee, two workers, email colour 2, and webhook colour 1. Real flags need not have this mixture of origins.",
    "The model assumes an atomic claim read and write and an accepted external send. It does not prove transaction isolation, SQL guards, or provider acceptance.",
    "The lease, the captured colour, and the holder are model memory. The application stores no lease row and has no clock or automatic expiry.",
    "The model checks safety. It does not prove that a recovery eventually runs, that a restore owns the lease, or that a buyer reads a message.",
  ],
  module: "NotificationFlagLease",
  safety:
    "Every live lease keeps a positive captured colour and a matching restore fact. Its stored flag stays zero. One holder name owns each side. Every fact used so far passed its rule.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/notification-flag-lease.ts",
          symbol: "REPRESENTATIVE",
        },
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "PENDING_NOTIFICATION",
        },
      ],
      rules: ["Init", "TypeOK", "Workers"],
      title: "Start with two owed sends",
      values: [
        { name: "storedEmail", value: "2 (admin-added, orange)" },
        { name: "storedWebhooks", value: "1 (online, red)" },
        { name: "emailLeased", value: "FALSE" },
        { name: "emailCaptured", value: "0" },
        { name: "emailHolder", value: "none" },
        { name: "allFactsSafe", value: "TRUE" },
      ],
      what: "The model starts with one attendee who owes an email and a webhook. The two colours differ, so a restore that writes one fixed colour is visible. Real flags need not have this mixture. Workers names the two recovery callers w1 and w2. TypeOK limits each flag to 0, 1, or 2 and each holder to none, w1, or w2.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "claimOutstandingNotificationFlags",
        },
      ],
      rules: ["ClaimStep", "ClaimValueCaptured", "SendStaysOwed"],
      title: "Claim both sides for w1",
      values: [
        { name: "beforeEmail", value: "2" },
        { name: "beforeWebhooks", value: "1" },
        { name: "claimsEmail", value: "TRUE" },
        { name: "claimsWebhooks", value: "TRUE" },
        { name: "worker", value: "w1" },
        { name: "storedEmailAfter", value: "0" },
        { name: "storedWebhooksAfter", value: "0" },
        { name: "emailCaptured", value: "2" },
        { name: "webhooksCaptured", value: "1" },
        { name: "emailHolder", value: "w1" },
      ],
      what: "The claim reads both flags and writes them to zero in one transaction. It returns the two colours. ClaimValueCaptured requires a positive before-value on each claimed side and no claim on a zero side. The stored flag stays zero while the lease holds the work, so SendStaysOwed keeps the debt in the captured value. The worker name records the holder.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/notification-flag-lease.ts",
          symbol: "claimFacts",
        },
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "claimOutstandingNotificationFlags",
        },
      ],
      rules: ["ClaimStep", "ClaimValueCaptured", "LeaseHasOneHolder"],
      title: "A second worker claims nothing",
      values: [
        { name: "beforeEmail", value: "0" },
        { name: "beforeWebhooks", value: "0" },
        { name: "worker", value: "w2" },
        { name: "claimsEmail", value: "FALSE" },
        { name: "claimsWebhooks", value: "FALSE" },
        { name: "emailHolder", value: "w1" },
        { name: "webhooksHolder", value: "w1" },
        { name: "emailCaptured", value: "2" },
        { name: "webhooksCaptured", value: "1" },
      ],
      what: "Worker w2 runs after the claim. It reads zero on both sides, so it captures nothing and keeps the live lease. One scalar holder for each side records the single owner. The claim facts cover both workers and every before-value that the representative can hold. The model assumes an atomic claim read and write, so it does not prove the SQL race.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "restorePendingFlagStatement",
        },
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "restoreClaimedNotificationFlags",
        },
      ],
      rules: ["RestoreStep", "RestoreWritesCaptured", "LeaseKeepsCaptured"],
      title: "A failed email send restores colour 2",
      values: [
        { name: "returnsEmail", value: "TRUE" },
        { name: "emailValue", value: "2" },
        { name: "returnsWebhooks", value: "FALSE" },
        { name: "storedEmailAfter", value: "2 (admin-added, orange)" },
        { name: "emailLeased", value: "FALSE" },
        { name: "emailCaptured", value: "0" },
        { name: "emailHolder", value: "none" },
        {
          name: "webhooks",
          value: "The lease stays with w1 and keeps colour 1.",
        },
      ],
      what: "The email send does not run or it fails, so the recovery restores the captured colour. The restore writes 2, not the online colour 1. A restore of 1 breaks RestoreWritesCaptured and turns the orange badge red. The named side loses its lease, capture, and holder. The webhook side stays leased. LeaseKeepsCaptured requires a restore fact for every live capture.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/notification-flags.ts",
          symbol: "clearPendingFlagStatement",
        },
      ],
      rules: ["ClearStep"],
      title: "An accepted email send clears the debt",
      values: [
        { name: "side", value: "email" },
        { name: "storedEmailBefore", value: "2" },
        { name: "emailLeasedBefore", value: "FALSE" },
        { name: "storedEmailAfter", value: "0" },
        { name: "webhooks", value: "Unchanged." },
      ],
      what: "The email send reaches external acceptance. A clear names the email side and sets its flag to zero. The production clear touches rows whose flag is up. The model also allows a clear on a live lease, because the claim already set that stored flag to zero. A refused send restores the captured colour instead. The other side stays as it was.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/notification-flag-lease.ts",
          symbol: "notificationFlagLeaseModelData",
        },
      ],
      rules: [
        "Safety",
        "Next",
        "LeaseKeepsCaptured",
        "SendStaysOwed",
        "LeaseHasOneHolder",
      ],
      title: "Every state keeps the debt visible",
      values: [
        {
          name: "live lease",
          value: "Captured colour 2, stored flag 0, holder w1.",
        },
        { name: "restore fact", value: "A fact that returns colour 2 exists." },
        { name: "holder", value: "w1 or none, never two names." },
        { name: "allFactsSafe", value: "TRUE" },
      ],
      what: "Safety joins TypeOK, the capture rule, the zero stored flag under a live lease, the holder rule, and every retained verdict. Next permits a claim, a restore, a clear, or a pause. No rule requires progress, so debt can persist. The model does not prove eventual delivery.",
    },
  ],
  title: "Lease two notification flags between two recoveries",
};
/* jscpd:ignore-end */
