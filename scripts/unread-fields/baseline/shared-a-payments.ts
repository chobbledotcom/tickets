import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

export const SHARED_A_PAYMENTS_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt([
    ["src/shared/accounting/store.ts", [{ name: "PostResult" }]],
  ])(["inserted", "skipped"]),
  ...identitiesAt([
    ["src/shared/booking-intent.ts", [{ name: "ListingAnswerRefs" }]],
  ])(["listingAnswerIds", "listingTextAnswerIds"]),
  ...identitiesAt([
    ["src/shared/booking/fold-tree.ts", [{ name: "FoldChildrenResult" }]],
  ])(["priceRuleByListingId"]),
  ...identitiesAt([
    ["src/shared/booking/page-packages.ts", [{ name: "PagePackage" }]],
  ])(["slug"]),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "BookingNode" }]]])([
    "dateSpan",
    "visibility",
  ]),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "BookingTree" }]]])([
    "rootRef",
  ]),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "DateSpan" }]]])([
    "date",
    "durationDays",
    "kind",
  ]),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "PriceRule" }]]])([
    "maxMinor",
    "minMinor",
  ]),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "QuantityRule" }]]])(
    ["max", "min"],
  ),
  ...identitiesAt([["src/shared/booking/tree.ts", [{ name: "RootRef" }]]])([
    "kind",
    "slugs",
  ]),
  ...identitiesAt([
    ["src/shared/bunny-cdn.ts", [{ name: "EdgeScriptSecret" }]],
  ])(["Id", "LastModified"]),
  ...identitiesAt([
    ["src/shared/catalog-fields/fields.ts", [{ name: "GroupInput" }]],
  ])(["description", "hidden", "termsAndConditions"]),
  ...identitiesAt([
    ["src/shared/catalog-fields/fields.ts", [{ name: "ListingInput" }]],
  ])([
    "attachmentName",
    "attachmentUrl",
    "bookableDays",
    "closesAt",
    "date",
    "description",
    "fields",
    "location",
    "maxAttendees",
    "maxQuantity",
    "minimumDaysBefore",
    "nonTransferable",
    "useDefaults",
    "usesLogistics",
  ]),
  ...identitiesAt([
    ["src/shared/catalog-fields/fields.ts", [{ name: "PackageMemberInput" }]],
  ])(["dayPrices", "price"]),
  ...identitiesAt([
    ["src/shared/checkout-pricing.ts", [{ name: "ModifierApplication" }]],
  ])(["amountApplied", "quantity", "scopedSubtotal"]),
  ...identitiesAt([
    ["src/shared/email-renderer.ts", [{ name: "TemplateData" }]],
  ])([
    "amount_owed",
    "attendee",
    "currency",
    "entries",
    "listing_names",
    "ticket_url",
  ]),
  ...identitiesAt([["src/shared/email.ts", [{ name: "EmailListing" }]]])([
    "active",
    "assign_built_site",
    "hidden",
    "initial_site_months",
    "listing_type",
  ]),
  ...identitiesAt([
    ["src/shared/email/bulk.ts", [{ name: "BulkBatchResponse" }]],
  ])(["ok"]),
  ...identitiesAt([["src/shared/email/bulk.ts", [{ name: "BulkSendResult" }]]])(
    ["batches", "unconfirmed"],
  ),
  ...identitiesAt([["src/shared/external-order.ts", [{ name: "Catalog" }]]])([
    "generatedAt",
  ]),
  ...identitiesAt([
    ["src/shared/external-order.ts", [{ name: "CatalogSourceListing" }]],
  ])(["active", "hidden"]),
  ...identitiesAt([
    ["src/shared/forms/definition.ts", [{ name: "FormDefinition" }]],
  ])(["sections"]),
  ...identitiesAt([["src/shared/forms/field.ts", [{ name: "ChoiceField" }]]])([
    "accept",
    "markdown",
  ]),
  ...identitiesAt([["src/shared/forms/field.ts", [{ name: "FileField" }]]])([
    "markdown",
    "options",
  ]),
  ...identitiesAt([["src/shared/forms/field.ts", [{ name: "InputField" }]]])([
    "accept",
    "markdown",
    "options",
  ]),
  ...identitiesAt([["src/shared/forms/field.ts", [{ name: "TextareaField" }]]])(
    ["accept", "options"],
  ),
  ...identitiesAt([
    ["src/shared/ledger/reconcile.ts", [{ name: "LegDiscrepancy" }]],
  ])(["eventGroup", "missing", "unexpected"]),
  ...identitiesAt([
    ["src/shared/ledger/reconcile.ts", [{ name: "ReconcileResult" }]],
  ])(["actual", "diff", "expected", "ok"]),
  ...identitiesAt([["src/shared/ledger/types.ts", [{ name: "Transfer" }]]])([
    "recordedAt",
  ]),
  ...identitiesAt([
    ["src/shared/listing-parents-rules.ts", [{ name: "EdgeListing" }]],
  ])(["day_prices"]),
  ...identitiesAt([
    ["src/shared/listing-templates.ts", [{ name: "ListingTemplate" }]],
  ])(["requiresDate"]),
  ...identitiesAt([
    ["src/shared/listings-actions.ts", [{ name: "ToggleActiveResult" }]],
  ])(["noChange"]),
  ...identitiesAt([
    [
      "src/shared/maintenance/definition.ts",
      [
        { name: "MaintenanceTaskBudget" },
        { name: "remaining" },
        { way: "()" },
        { way: "result" },
      ],
    ],
  ])(["database", "external", "total"]),
  ...identitiesAt([
    [
      "src/shared/maintenance/definition.ts",
      [{ name: "MaintenanceTaskBudget" }],
    ],
  ])(["remaining"]),
  ...identitiesAt([
    [
      "src/shared/maintenance/definition.ts",
      [{ name: "MaintenanceTaskContext" }],
    ],
  ])(["budget", "deadline"]),
  ...identitiesAt([
    [
      "src/shared/merge/attendee-merge-types.ts",
      [{ name: "ApplyAttendeeMergeInput" }, { name: "targetPii" }],
    ],
  ])(["payment_id", "ticket_token"]),
  ...identitiesAt([
    [
      "src/shared/merge/attendee-merge-types.ts",
      [{ name: "AttendeeMergeApplyResult" }],
    ],
  ])(["success"]),
  ...identitiesAt([
    [
      "src/shared/merge/attendee-merge-types.ts",
      [{ name: "AttendeeMergeApplySummary" }],
    ],
  ])(["answersKept", "piiFieldsFromSource"]),
  ...identitiesAt([
    [
      "src/shared/merge/attendee-merge-types.ts",
      [{ name: "AttendeeMergeDiff" }],
    ],
  ])(["sourceId", "targetId"]),
  ...identitiesAt([
    ["src/shared/order/options.ts", [{ name: "OrderOptionState" }]],
  ])(["byKey"]),
  ...identitiesAt([
    [
      "src/shared/payment-providers.ts",
      [{ name: "PaymentProviderMeta" }, { name: "webhook" }],
    ],
  ])(["signatureHeader"]),
  ...identitiesAt([
    ["src/shared/payment-providers.ts", [{ name: "PaymentProviderMeta" }]],
  ])([
    "currencies",
    "label",
    "metadata",
    "refundCapability",
    "secretField",
    "webhook",
  ]),
  ...identitiesAt([
    ["src/shared/payment/admit-move.ts", [{ name: "PaymentWork" }]],
  ])(["recoveryAction"]),
  ...identitiesAt([
    [
      "src/shared/payment/admit-refund.ts",
      [{ name: "ObservedRefundAdmission" }],
    ],
  ])(["request"]),
  ...identitiesAt([
    [
      "src/shared/payment/checkout-failure.ts",
      [{ name: "ProviderCheckoutError" }],
    ],
  ])(["provider", "reason", "statusCode"]),
  ...identitiesAt([
    ["src/shared/payment/claim.ts", [{ name: "ClaimDecision" }]],
  ])(["resuming"]),
  ...identitiesAt([
    ["src/shared/payment/claim.ts", [{ name: "HeldPaymentRow" }]],
  ])(["attendeeId"]),
  ...identitiesAt([
    ["src/shared/payment/claim.ts", [{ name: "HeldRefundCommand" }]],
  ])(["commandId", "held", "heldSince"]),
  ...identitiesAt([
    ["src/shared/payment/claim.ts", [{ name: "IndexedRefundClaimDecision" }]],
  ])(["indexes", "kind"]),
  ...identitiesAt([
    ["src/shared/payment/joint-state.ts", [{ name: "IllegalJointState" }]],
  ])(["authority", "reason", "rows"]),
  ...identitiesAt([
    ["src/shared/payment/refund-attempt.ts", [{ name: "RefundActionResult" }]],
  ])(["admission"]),
  ...identitiesAt([
    ["src/shared/payment/refund-attempt.ts", [{ name: "RefundAttemptResult" }]],
  ])(["proof"]),
  ...identitiesAt([
    ["src/shared/payment/refund-attempt.ts", [{ name: "RefundProof" }]],
  ])(["charge", "kind", "refund"]),
  ...identitiesAt([
    [
      "src/shared/payment/refund-authority-lifecycle.ts",
      [{ name: "RefundLifecycle" }],
    ],
  ])(["blocks", "refusal", "requiresChoice"]),
  ...identitiesAt([
    [
      "src/shared/payment/refund-provider-authorization.ts",
      [{ name: "KeyedRefundAuthorization" }],
    ],
  ])([
    "capability",
    "generation",
    "idempotencyKey",
    "identityIndex",
    "provider",
  ]),
  ...identitiesAt([
    [
      "src/shared/payment/refund-provider-authorization.ts",
      [{ name: "KeylessRefundAuthorization" }],
    ],
  ])(["capability", "generation", "identityIndex", "provider"]),
  ...identitiesAt([
    [
      "src/shared/payment/row-transitions.ts",
      [{ name: "PaymentRowSettlement" }],
    ],
  ])(["claim"]),
  ...identitiesAt([["src/shared/payments.ts", [{ name: "CheckoutIntent" }]]])([
    "balanceAttendeeId",
    "date",
    "dayCount",
  ]),
  ...identitiesAt([
    ["src/shared/payments.ts", [{ name: "CheckoutSessionResult" }]],
  ])(["sessionId"]),
  ...identitiesAt([["src/shared/payments.ts", [{ name: "SessionMetadata" }]]])([
    "_origin",
  ]),
];
