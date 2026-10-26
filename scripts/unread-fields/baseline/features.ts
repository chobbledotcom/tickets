// jscpd:ignore-start
import { way } from "#scripts/unread-fields/fields/steps.ts";
import {
  type FindingIdentity,
  identitiesAt,
  ownerAt,
} from "#scripts/unread-fields/identity.ts";

// jscpd:ignore-end

const inCatalogTransfer = ownerAt(
  "src/features/admin/catalog-transfer/schema.ts",
);

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
  ])(["slug"]),
  ...identitiesAt([
    ["src/features/admin/api-listing-body.ts", [{ name: "CreateListingBody" }]],
  ])(LISTING_BODY_FIELDS),
  ...identitiesAt([
    ["src/features/admin/api-listing-body.ts", [{ name: "UpdateListingBody" }]],
  ])(["slug"]),
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
    "nav",
    "prefill",
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
  ...identitiesAt([
    inCatalogTransfer("ListingData"),
    inCatalogTransfer("ListingTransfer", "listing"),
    inCatalogTransfer("CatalogTransfer", "listing"),
  ])([
    "description",
    "location",
    "maxAttendees",
    "nonTransferable",
    "useDefaults",
    "usesLogistics",
  ]),
  ...identitiesAt([
    inCatalogTransfer("GroupData"),
    inCatalogTransfer("GroupTransfer", "group"),
    inCatalogTransfer("CatalogTransfer", "group"),
  ])([
    "description",
    "hidden",
    "scanChecksInAllListings",
    "showHiddenListings",
    "termsAndConditions",
  ]),
  ...identitiesAt([
    inCatalogTransfer("ListingMembership"),
    inCatalogTransfer("GroupMember"),
    inCatalogTransfer("ListingTransfer", "groups", way("[]")),
    inCatalogTransfer("GroupTransfer", "members", way("[]")),
    inCatalogTransfer("CatalogTransfer", "groups", way("[]")),
    inCatalogTransfer("CatalogTransfer", "members", way("[]")),
  ])(["packagePrice", "quantity"]),
  ...identitiesAt([
    inCatalogTransfer("ListingTransfer"),
    inCatalogTransfer("GroupTransfer"),
    inCatalogTransfer("CatalogTransfer"),
  ])(["version"]),
];
