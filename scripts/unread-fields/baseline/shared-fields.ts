import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

/** Owners with the same unread fields share one declaration. */
export const SHARED_FIELD_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt([
    [
      "src/shared/admin-surface/definitions.ts",
      [{ name: "AdminSurfaceContext" }],
    ],
    ["src/shared/db/groups/candidates.ts", [{ name: "GroupListingCandidate" }]],
    ["src/shared/db/modifier-resolve.ts", [{ name: "ListingGroupMembership" }]],
  ])(["active"]),
  ...identitiesAt([
    ["src/shared/payment/refund-machine-spec.ts", [{ name: "RefundNode" }]],
    ["src/shared/payment/review-machine-spec.ts", [{ name: "ReviewNode" }]],
    ["src/shared/payment/row-machine-spec.ts", [{ name: "RowNode" }]],
    [
      "src/shared/payment/sumup-recovery-machine-spec.ts",
      [{ name: "RecoveryNode" }],
    ],
    ["src/shared/schema-atlas/machine-spec.ts", [{ name: "MachineNode" }]],
  ])(["awaits"]),
  ...identitiesAt([
    ["src/shared/ledger/types.ts", [{ name: "LedgerError" }]],
    ["src/shared/db/modifiers.ts", [{ name: "ModifierRow" }]],
    ["src/shared/types.ts", [{ name: "Modifier" }]],
  ])(["code"]),
  ...identitiesAt([
    ["src/features/admin/api-groups.ts", [{ name: "DeleteGroupBody" }]],
    ["src/features/admin/api-holidays.ts", [{ name: "DeleteHolidayBody" }]],
    ["src/features/admin/api.ts", [{ name: "DeleteListingBody" }]],
    ["src/shared/rest/crud-parsers.ts", [{ name: "DeleteBody" }]],
  ])(["confirm_identifier"]),
  ...identitiesAt([
    [
      "src/ui/templates/admin/debug.tsx",
      [{ name: "DebugPageState" }, { name: "appleWallet" }],
    ],
    [
      "src/ui/templates/admin/debug.tsx",
      [{ name: "DebugPageState" }, { name: "googleWallet" }],
    ],
  ])(["dbConfigured", "envConfigured", "source"]),
  ...identitiesAt([
    ["src/shared/provider-types.ts", [{ name: "DatabaseCredentials" }]],
    ["src/shared/turso-api.ts", [{ name: "TursoDatabaseCredentials" }]],
  ])(["dbId"]),
  ...identitiesAt([
    ["src/shared/balance-link.ts", [{ name: "BalancePayload" }]],
    ["src/shared/qr-token.ts", [{ name: "QrBookPayload" }]],
  ])(["e"]),
  ...identitiesAt([
    ["src/features/admin/api-holidays.ts", [{ name: "CreateHolidayBody" }]],
    ["src/features/admin/api-holidays.ts", [{ name: "UpdateHolidayBody" }]],
  ])(["end_date", "name", "start_date"]),
  ...identitiesAt([
    ["src/shared/db/notes/types.ts", [{ name: "SystemNote" }]],
    ["src/shared/db/notes/types.ts", [{ name: "SystemNoteRow" }]],
  ])(["entity_type"]),
  ...identitiesAt([
    ["src/shared/admin-surface/sections.ts", [{ name: "AdminSectionDef" }]],
    ["src/shared/db/activity-log.ts", [{ name: "ActivityLogEntry" }]],
    [
      "src/shared/payment/refund-machine-spec.ts",
      [{ name: "RefundMachineEvent" }],
    ],
    [
      "src/shared/payment/review-machine-spec.ts",
      [{ name: "ReviewMachineEvent" }],
    ],
    ["src/shared/payment/row-machine-spec.ts", [{ name: "RowMachineEvent" }]],
    [
      "src/shared/payment/sumup-recovery-machine-spec.ts",
      [{ name: "RecoveryMachineEvent" }],
    ],
    ["src/shared/schema-atlas/machine-spec.ts", [{ name: "MachineEvent" }]],
    [
      "src/shared/square/wire.ts",
      [{ name: "SquareOrder" }, { name: "tenders" }, { way: "[]" }],
    ],
    ["src/shared/square/wire.ts", [{ name: "SquareRefund" }]],
    ["src/shared/types.ts", [{ name: "NagItem" }]],
  ])(["id"]),
  ...identitiesAt([
    [
      "src/features/admin/refunds/budget.ts",
      [{ name: "RefundSendBudgetReference" }],
    ],
    [
      "src/features/admin/refunds/readiness.ts",
      [{ name: "RefundReadinessRead" }],
    ],
  ])(["index"]),
  ...identitiesAt([
    ["src/shared/db/table.ts", [{ name: "CrudTable" }]],
    ["src/shared/db/table.ts", [{ name: "Table" }]],
  ])(["inputKeyMap", "schema", "toDbValues"]),
  ...identitiesAt([
    ["src/shared/admin-surface/sections.ts", [{ name: "AdminNavEntry" }]],
    ["src/shared/db/attendees/servicing.ts", [{ name: "ServicingEvent" }]],
    ["src/shared/payment/claim.ts", [{ name: "RefundClaimChanged" }]],
  ])(["kind"]),
  ...identitiesAt([
    ["src/shared/booking/cart-conflicts.ts", [{ name: "CartDateItem" }]],
    ["src/shared/booking/cart-conflicts.ts", [{ name: "CartLengthItem" }]],
    ["src/shared/boot-checks.ts", [{ name: "BootCheck" }]],
    ["src/shared/db/holidays.ts", [{ name: "HolidayInput" }]],
    ["src/shared/db/logistics-agents.ts", [{ name: "LogisticsAgentInput" }]],
  ])(["name"]),
  ...identitiesAt([
    ["src/shared/rest/resource.ts", [{ name: "DeleteResult" }]],
    ["src/shared/rest/resource.ts", [{ name: "UpdateResult" }]],
  ])(["notFound"]),
  ...identitiesAt([
    ["src/shared/db/attendees/select.ts", [{ name: "GetAttendeesQuery" }]],
    ["src/shared/db/listings/select.ts", [{ name: "GetListingsQuery" }]],
  ])(["order"]),
  ...identitiesAt([
    [
      "src/shared/db/provider-refund-authority.ts",
      [{ name: "RefundAuthorityRow" }],
    ],
    [
      "src/shared/payment/transport-error.ts",
      [{ name: "ProviderTransportError" }],
    ],
  ])(["provider"]),
  ...identitiesAt([
    ["src/features/admin/refunds/claim.ts", [{ name: "RefundRunBlock" }]],
    ["src/features/admin/refunds/provider.ts", [{ name: "RefundBatchResult" }]],
    [
      "src/features/admin/refunds/refresh.ts",
      [{ name: "RefreshPaymentResult" }],
    ],
    ["src/shared/superuser.ts", [{ name: "SuperuserState" }]],
  ])(["reason"]),
  ...identitiesAt([
    ["src/shared/payments.ts", [{ name: "ExistingPaymentProvider" }]],
    ["src/shared/payments.ts", [{ name: "PaymentProvider" }]],
  ])(["setupWebhookEndpoint"]),
  ...identitiesAt([
    ["src/shared/db/images.ts", [{ name: "OrderedImage" }]],
    [
      "src/shared/listing-attribute-filter.ts",
      [{ name: "AttributeFilterGroup" }],
    ],
  ])(["sort_order"]),
  ...identitiesAt([
    ["src/shared/provider-refunds.ts", [{ name: "ProviderRefundResult" }]],
    ["src/shared/square/wire.ts", [{ name: "SquareOrder" }]],
  ])(["state"]),
  ...identitiesAt([
    ["src/shared/db/questions/strings.ts", [{ name: "PreparedStringRow" }]],
    [
      "src/shared/sms/gateway.ts",
      [{ name: "EncryptedMessagePayload" }, { name: "textMessage" }],
    ],
  ])(["text"]),
  ...identitiesAt([
    ["src/shared/jsx/jsx-runtime.ts", [{ name: "Child" }]],
    ["src/shared/jsx/jsx-runtime.ts", [{ name: "SafeHtml" }]],
  ])(["toString"]),
];
