import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

const PARENT_LISTING_FIELDS = ["parentListingId"] as const;
const ASSIGNED_LISTING_FIELDS = ["assignedListingId"] as const;
const BUILT_SITE_SHARED_FIELD_NAMES = [
  { input: "assignable", row: "assignable" },
  { input: "assignedAttendeeId", row: "assigned_attendee_id" },
  { input: "assignedListingId", row: "assigned_listing_id" },
  { input: "readOnlyFrom", row: "read_only_from" },
  { input: "renewalTokenIndex", row: "renewal_token_index" },
] as const;
const BUILT_SITE_INPUT_FIELDS = BUILT_SITE_SHARED_FIELD_NAMES.map(
  ({ input }) => input,
);
const BUILT_SITE_ROW_FIELDS = BUILT_SITE_SHARED_FIELD_NAMES.map(
  ({ row }) => row,
);

export const SHARED_DB_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt([
    ["src/shared/db/activity-log.ts", [{ name: "ActivityLogInput" }]],
  ])(["attendeeId", "listingId", "message"]),
  ...identitiesAt([
    ["src/shared/db/activity-log.ts", [{ name: "ListingWithActivityLog" }]],
  ])(["listing"]),
  ...identitiesAt([
    ["src/shared/db/attendee-types.ts", [{ name: "DesiredListingLine" }]],
    [
      "src/shared/db/attendees/atomic-update.ts",
      [{ name: "AtomicDesiredLine" }],
    ],
  ])(PARENT_LISTING_FIELDS),
  ...identitiesAt([
    [
      "src/shared/db/attendees/atomic-update.ts",
      [{ name: "UpdateAttendeeAtomicResult" }],
    ],
  ])(["listingIds"]),
  ...identitiesAt([
    ["src/shared/db/attendees/balance.ts", [{ name: "SettleBalanceResult" }]],
  ])(["amount", "listingId"]),
  ...identitiesAt([
    ["src/shared/db/attendees/capacity/range.ts", [{ name: "IntervalRow" }]],
  ])(["quantity"]),
  ...identitiesAt([
    ["src/shared/db/attendees/pii.ts", [{ name: "DecryptedAttendeeRow" }]],
  ])(["checked_in", "split_logistics_agents"]),
  ...identitiesAt([
    [
      "src/shared/db/attendees/servicing.ts",
      [{ name: "ServicingBookingSummary" }],
    ],
  ])(["listingId"]),
  ...identitiesAt([
    ["src/shared/db/attributes.ts", [{ name: "AttributeOption" }]],
  ])(["attribute_id"]),
  ...identitiesAt([
    ["src/shared/db/backup.ts", [{ name: "BackupInspection" }]],
  ])(["manifest", "statementCount"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSite" }]],
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSitePlainFields" }]],
  ])(ASSIGNED_LISTING_FIELDS),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSiteBlobInput" }]],
  ])(["renewalToken"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSiteFormInput" }]],
  ])(["dbProvider", "hostingProvider", "updates"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSiteInput" }]],
  ])([...BUILT_SITE_INPUT_FIELDS, "siteData", "updates"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSitePlainInput" }]],
  ])([...BUILT_SITE_INPUT_FIELDS, "updates"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSiteRow" }]],
  ])([...BUILT_SITE_ROW_FIELDS, "site_data_revision", "updates"]),
  ...identitiesAt([
    ["src/shared/db/built-sites/types.ts", [{ name: "BuiltSiteUpdate" }]],
  ])(["assignedListingId", "renewalToken"]),
  ...identitiesAt([
    [
      "src/shared/db/common-schema.ts",
      [{ name: "AggregateRecalculation" }, { way: "[]" }],
    ],
  ])(["recalculated"]),
  ...identitiesAt([
    ["src/shared/db/common-schema.ts", [{ name: "NamedSortOrderInput" }]],
  ])(["name", "sortOrder"]),
  ...identitiesAt([
    ["src/shared/db/contact-tokens.ts", [{ name: "BookingToken" }]],
  ])(["token"]),
  ...identitiesAt([["src/shared/db/images.ts", [{ name: "ImageInput" }]]])([
    "altText",
    "filename",
    "filenameThumb",
    "name",
  ]),
  ...identitiesAt([
    ["src/shared/db/listing-parents.ts", [{ name: "HydratedListingLinks" }]],
  ])(["idsByKey"]),
  ...identitiesAt([
    ["src/shared/db/listing-parents.ts", [{ name: "ParentAndChildLinkMaps" }]],
  ])(["childIdsByParent"]),
  ...identitiesAt([
    ["src/shared/db/modifiers.ts", [{ name: "ModifierInput" }]],
  ])([
    "calcKind",
    "calcValue",
    "codeIndex",
    "direction",
    "minSubtotal",
    "stock",
  ]),
  ...identitiesAt([
    ["src/shared/db/news-posts.ts", [{ name: "NewsPostInput" }]],
  ])(["created", "slugIndex"]),
  ...identitiesAt([
    ["src/shared/db/numbered-statement.ts", [{ name: "SqlParameterToken" }]],
  ])(["sql"]),
  ...identitiesAt([
    [
      "src/shared/db/ordered-collection.ts",
      [
        { name: "OrderedCollection" },
        { name: "nextMany" },
        { way: "()" },
        { way: "operation" },
      ],
    ],
  ])(["transaction"]),
  ...identitiesAt([
    [
      "src/shared/db/payment-reference-rows.ts",
      [{ name: "PaymentReferenceRow" }],
    ],
  ])(["payment_reference", "payment_reference_index"]),
  ...identitiesAt([
    [
      "src/shared/db/payment-reference-store.ts",
      [{ name: "IndexedPaymentReferenceSource" }],
    ],
  ])(["payment_session_id"]),
  ...identitiesAt([
    ["src/shared/db/payment-review.ts", [{ name: "PaymentReviewState" }]],
  ])(["allAcknowledged"]),
  ...identitiesAt([
    ["src/shared/db/processed-payments.ts", [{ name: "ProcessedPayment" }]],
  ])(["payment_reference", "payment_session_id", "processed_at"]),
  ...identitiesAt([
    [
      "src/shared/db/provider-refund-cases.ts",
      [{ name: "ProviderRefundCase" }],
    ],
  ])(["decision", "updatedAt"]),
  ...identitiesAt([
    [
      "src/shared/db/provider-refund-cases.ts",
      [{ name: "ProviderRefundCaseSummary" }],
    ],
  ])(["updatedAt"]),
  ...identitiesAt([["src/shared/db/question-types.ts", [{ name: "Answer" }]]])([
    "question_id",
    "sort_order",
  ]),
  ...identitiesAt([
    ["src/shared/db/question-types.ts", [{ name: "Question" }]],
  ])(["assign_all"]),
  ...identitiesAt([
    [
      "src/shared/db/refund-all-candidates.ts",
      [{ name: "RefundAllCandidateAttendee" }],
    ],
  ])(["id", "quantity", "refunded"]),
  ...identitiesAt([
    ["src/shared/db/settings/snapshot.ts", [{ name: "SettingsData" }]],
  ])([
    "auto_purge_orphans",
    "booking_fee",
    "calendar_feeds_enabled",
    "calendar_feeds_group_by",
    "contact_form_enabled",
    "country",
    "currency",
    "external_order_enabled",
    "order_enabled",
    "orphan_purge_retention",
    "payment_provider",
    "payment_provider_setting",
    "phone_prefix",
    "show_public_api",
    "square_sandbox",
    "superuser_choice",
    "theme",
    "timezone",
    "underline_links",
  ]),
  ...identitiesAt([
    ["src/shared/db/site-pages.ts", [{ name: "SitePageInput" }]],
  ])(["slugIndex", "sortOrder"]),
  ...identitiesAt([
    [
      "src/shared/db/slugged-content-input.ts",
      [{ name: "SluggedContentInput" }],
    ],
  ])(["slugIndex"]),
  ...identitiesAt([
    ["src/shared/db/sms-messages.ts", [{ name: "SmsMessageRow" }]],
  ])(["created", "provider_id"]),
];
