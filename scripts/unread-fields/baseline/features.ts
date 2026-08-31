import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

const LISTING_BODY_FIELDS = [
  "child_listing_ids",
  "date",
  "day_prices",
  "group_ids",
  "max_attendees",
  "max_price",
  "name",
] as const;

export const FEATURE_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt([
    ["src/features/admin/actions.ts", [{ name: "AttendeeLinkRefs" }]],
  ])(["kinds", "names"]),
  ...identitiesAt([
    ["src/features/admin/api-groups.ts", [{ name: "CreateGroupBody" }]],
  ])(["name", "package_members"]),
  ...identitiesAt([
    ["src/features/admin/api-groups.ts", [{ name: "PackageMemberBody" }]],
  ])(["day_prices", "listing_id", "price", "quantity"]),
  ...identitiesAt([
    ["src/features/admin/api-groups.ts", [{ name: "UpdateGroupBody" }]],
  ])(["name", "package_members", "slug"]),
  ...identitiesAt([
    ["src/features/admin/api-listing-body.ts", [{ name: "CreateListingBody" }]],
  ])(LISTING_BODY_FIELDS),
  ...identitiesAt([
    ["src/features/admin/api-listing-body.ts", [{ name: "UpdateListingBody" }]],
  ])([...LISTING_BODY_FIELDS, "slug"]),
  ...identitiesAt([
    [
      "src/features/admin/attendee-form-model.ts",
      [{ name: "AttendeeFieldError" }],
    ],
  ])(["field"]),
  ...identitiesAt([
    [
      "src/features/admin/attendee-form-model.ts",
      [{ name: "ValidationResult" }],
    ],
  ])(["lineErrors"]),
  ...identitiesAt([
    [
      "src/features/admin/attendee-logistics.ts",
      [{ name: "LogisticsFormErrors" }],
    ],
  ])(["addressError", "locationError"]),
  ...identitiesAt([
    [
      "src/features/admin/refunds/budget.ts",
      [{ name: "RefundBudgetCandidate" }],
    ],
  ])(["references"]),
  ...identitiesAt([
    [
      "src/features/admin/refunds/ledger-findings.ts",
      [{ name: "AppliedRefundLedgerFindings" }],
    ],
  ])(["needsReview"]),
  ...identitiesAt([
    [
      "src/features/admin/refunds/readiness.ts",
      [{ name: "RefundReadinessResult" }],
    ],
  ])(["reads"]),
  ...identitiesAt([
    [
      "src/features/admin/servicing/form-model.ts",
      [{ name: "ServicingCreateInput" }],
    ],
  ])(["bookings", "kind", "name"]),
  ...identitiesAt([
    [
      "src/features/admin/settings-connection-lines.ts",
      [{ name: "ConnectionAnswer" }],
    ],
  ])(["lines", "ok"]),
  ...identitiesAt([
    ["src/features/api/payment-callback.ts", [{ name: "CallbackOutcome" }]],
  ])(["result"]),
  ...identitiesAt([
    [
      "src/features/api/payment-processing/create.ts",
      [{ name: "AttendeeBaseFields" }],
    ],
  ])(["paymentId", "statusId"]),
  ...identitiesAt([
    [
      "src/features/api/payment-processing/placeholder-resume.ts",
      [{ name: "PlaceholderFailureResult" }],
    ],
  ])(["status"]),
  ...identitiesAt([
    ["src/features/api/webhook-types.ts", [{ name: "ListingValidation" }]],
  ])(["error", "status"]),
  ...identitiesAt([
    ["src/features/api/webhook-types.ts", [{ name: "PaymentResult" }]],
  ])(["attendee"]),
  ...identitiesAt([["src/features/auth.ts", [{ name: "AuthSession" }]]])([
    "settingsNagItems",
  ]),
  ...identitiesAt([
    ["src/features/entity.ts", [{ name: "AttendeeListingRouteParams" }]],
  ])(["attendeeId", "listingId"]),
  ...identitiesAt([["src/features/public/types.ts", [{ name: "TicketCtx" }]]])([
    "attributesByListing",
    "baseUrl",
    "cartDateItems",
    "childDatesById",
    "galleryImages",
    "groupDescription",
    "groupImage",
    "groupName",
    "nav",
    "prefill",
    "promoCodesEnabled",
  ]),
  ...identitiesAt([
    ["src/features/public/types.ts", [{ name: "TicketSharedContext" }]],
  ])([
    "cartDateItems",
    "childDatesById",
    "galleryImages",
    "groupDescription",
    "groupImage",
    "groupName",
    "promoCodesEnabled",
  ]),
];
