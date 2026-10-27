// jscpd:ignore-start
import { way } from "#scripts/unread-fields/fields/steps.ts";
import {
  type FindingIdentity,
  identitiesAt,
  ownerAt,
} from "#scripts/unread-fields/identity.ts";

// jscpd:ignore-end

const inAdminApi = ownerAt("src/shared/admin-api-resources.ts");

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
    ["src/shared/schema-atlas/machine-spec.ts", [{ name: "MachineNode" }]],
  ])(["awaits"]),
  ...identitiesAt([
    ["src/shared/ledger/types.ts", [{ name: "LedgerError" }]],
    ["src/shared/types.ts", [{ name: "Modifier" }]],
  ])(["code"]),
  ...identitiesAt([
    ["src/shared/rest/crud-parsers.ts", [{ name: "DeleteBody" }]],
  ])(["confirm_identifier"]),
  ...identitiesAt([
    [
      "src/ui/templates/admin/debug-state.ts",
      [{ name: "DebugPageState" }, { name: "appleWallet" }],
    ],
    [
      "src/ui/templates/admin/debug-state.ts",
      [{ name: "DebugPageState" }, { name: "googleWallet" }],
    ],
  ])(["dbConfigured", "envConfigured", "source"]),
  ...identitiesAt([
    ["src/shared/provider-types.ts", [{ name: "DatabaseCredentials" }]],
  ])(["dbId"]),
  ...identitiesAt([
    ["src/shared/balance-link.ts", [{ name: "BalancePayload" }]],
    ["src/shared/qr-token.ts", [{ name: "QrBookPayload" }]],
  ])(["e"]),
  ...identitiesAt([
    ["src/features/admin/api-holidays.ts", [{ name: "CreateHolidayBody" }]],
  ])(["end_date", "name", "start_date"]),
  ...identitiesAt([["src/shared/db/notes/types.ts", [{ name: "SystemNote" }]]])(
    ["entity_type"],
  ),
  ...identitiesAt([
    ["src/shared/admin-surface/sections.ts", [{ name: "AdminSectionDef" }]],
    ["src/shared/db/activity-log.ts", [{ name: "ActivityLogEntry" }]],
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
  ...identitiesAt([["src/shared/payments.ts", [{ name: "PaymentProvider" }]]])([
    "setupWebhookEndpoint",
  ]),
  ...identitiesAt([
    ["src/shared/db/images.ts", [{ name: "OrderedImage" }]],
    [
      "src/shared/listing-attribute-filter.ts",
      [{ name: "AttributeFilterGroup" }],
    ],
  ])(["sort_order"]),
  ...identitiesAt([
    ["src/shared/provider-refunds.ts", [{ name: "ProviderRefundResult" }]],
  ])(["state"]),
  ...identitiesAt([
    [
      "src/shared/sms/gateway.ts",
      [{ name: "EncryptedMessagePayload" }, { name: "textMessage" }],
    ],
  ])(["text"]),
  ...identitiesAt([["src/shared/jsx/jsx-runtime.ts", [{ name: "SafeHtml" }]]])([
    "toString",
  ]),
  ...identitiesAt([
    ["src/shared/listing-defaults.ts", [{ name: "ListingDefaults" }]],
  ])([
    "bookableDays",
    "maximumDaysAfter",
    "minimumDaysBefore",
    "thankYouUrl",
    "webhookUrl",
  ]),
  ...identitiesAt([
    ["src/shared/booking-intent.ts", [{ name: "TextAnswerRef" }]],
  ])(["s"]),
  ...identitiesAt([
    ownerAt("src/shared/booking-intent.ts")(
      "BookingIntent",
      "allocations",
      way("[]"),
    ),
  ])(["qty"]),
  ...identitiesAt([
    ownerAt("src/shared/square/client.ts")(
      "SquareClient",
      "checkout",
      "paymentLinks",
      "create",
      way("()"),
      way("result"),
    ),
  ])(["createdAt", "linkId", "orderId", "url"]),
  ...identitiesAt([
    inAdminApi("AdminApiCreateHolidayBody"),
    inAdminApi("AdminApiUpdateHolidayBody"),
  ])(["end_date", "name", "start_date"]),
  ...identitiesAt([inAdminApi("AdminApiHoliday")])([
    "end_date",
    "id",
    "name",
    "start_date",
  ]),
  ...identitiesAt([
    inAdminApi("AdminApiCreateAttributeBody"),
    inAdminApi("AdminApiUpdateAttributeBody"),
  ])(["name"]),
  ...identitiesAt([inAdminApi("AdminApiOptionBody")])(["text"]),
  ...identitiesAt([
    inAdminApi("AdminApiCreateQuestionBody"),
    inAdminApi("AdminApiUpdateQuestionBody"),
  ])(["assign_all", "display_type", "text"]),
  ...identitiesAt([inAdminApi("AdminApiQuestion")])([
    "answers",
    "assign_all",
    "display_type",
  ]),
  ...identitiesAt([inAdminApi("AdminApiDeleteBody")])(["confirm_identifier"]),
  ...identitiesAt([inAdminApi("AdminApiDeleteAnswer")])(["status"]),
];
