/**
 * The alphabetical second half of the admin-area registry: the areas from
 * `markdownPreview` through `users`. See `areas.ts` for what a declaration
 * means, and join a new area to the half its name sorts into.
 */

import {
  OWNER_AUDIENCE,
  onePageAreas,
} from "#shared/admin-surface/definitions.ts";
import {
  childWrites,
  contentWrites,
  recordArea,
} from "#shared/admin-surface/record-area.ts";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";
import {
  CONTENT_ADMIN_LEVELS,
  DOOR_ADMIN_LEVELS,
  SITE_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#types";

/** The admin areas from `markdownPreview` through `users`. */
export const AREAS_M_Z = {
  markdownPreview: {
    audience: CONTENT_ADMIN_LEVELS,
    write: {
      markdownPreview: "/admin/markdown-preview",
    },
  },
  migrate: {
    audience: OWNER_AUDIENCE,
    view: {
      migrateRebuildPayments: "/admin/migrate/rebuild-payment-references",
    },
  },
  modifiers: recordArea({
    audience: STAFF_ADMIN_LEVELS,
    extraWrites: {
      modifierAnswers: "/admin/modifiers/:id/answers",
      modifierLinks: "/admin/modifiers/:id/links",
      modifierRecalculate: "/admin/modifiers/recalculate/:modifierId",
      modifierRevenue: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/modifiers/:id/revenue",
      },
    },
    name: "modifiers",
    singular: "modifier",
  }),
  news: recordArea({
    audience: SITE_ADMIN_LEVELS,
    basePath: "/admin/site/news",
    extraWrites: {
      ...contentWrites("news", "/admin/site/news/:id"),
      ...ORDERED_LISTS.newsImage.writes,
    },
    name: "news",
    prefix: "news",
    singular: "newsPost",
  }),
  privacy: {
    audience: OWNER_AUDIENCE,
    view: {
      privacy: "/admin/privacy",
      privacyRefund: "/admin/privacy/refunds/:id",
    },
    write: {
      privacyErase: "/admin/privacy/erase",
      privacyOrphans: "/admin/privacy/orphans",
    },
  },
  questions: recordArea({
    audience: OWNER_AUDIENCE,
    extraWrites: {
      ...childWrites(ORDERED_LISTS.answer),
      answerRecalculate: "/admin/questions/:id/answers/:answerId/recalculate",
      questionListings: "/admin/questions/:id/listings",
      ...ORDERED_LISTS.question.writes,
    },
    name: "questions",
    newPage: false,
    segments: ["listing"],
    singular: "question",
  }),
  // Owner only. An operator adds and deletes a redirect. No form edits one,
  // and a redirect has no page of its own.
  redirects: recordArea({
    audience: OWNER_AUDIENCE,
    detailPage: false,
    editPage: false,
    name: "redirects",
    singular: "redirect",
  }),
  scanner: {
    audience: DOOR_ADMIN_LEVELS,
    view: {
      doors: "/admin/scanner",
      groupScanCache: "/admin/groups/:id/scan-cache",
      groupScanner: "/admin/groups/:id/scanner",
      listingScanCache: "/admin/listing/:id/scan-cache",
      listingScanner: "/admin/listing/:id/scanner",
    },
    write: {
      groupScan: {
        pattern: "/admin/groups/:id/scan",
        readOnlyWrite: "read-only",
      },
      listingScan: {
        pattern: "/admin/listing/:id/scan",
        readOnlyWrite: "read-only",
      },
    },
  },
  servicing: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      servicing: "/admin/servicing",
    },
    write: {
      servicingCost: "/admin/servicing/:id/cost/:costId",
      servicingDelete: "/admin/servicing/:id/delete",
      servicingDuplicate: "/admin/servicing/:id/duplicate",
      servicingEdit: "/admin/servicing/:id",
      servicingNew: "/admin/servicing/new",
    },
  },
  settings: {
    audience: OWNER_AUDIENCE,
    view: {
      feature: "/admin/features/:slug",
      listingDefaults: "/admin/listing-defaults",
      settings: "/admin/settings",
      settingsAdvanced: "/admin/settings-advanced",
    },
    write: {
      /* jscpd:ignore-start -- a list of strings, not code */
      settingsAddressLookup: "/admin/settings/address-lookup",
      settingsAppleWallet: "/admin/settings/apple-wallet",
      settingsAttendeeColumnOrder: "/admin/settings/attendee-column-order",
      settingsBookingFee: "/admin/settings/booking-fee",
      settingsBusinessEmail: "/admin/settings/business-email",
      settingsCalendarFeeds: "/admin/settings/calendar-feeds",
      settingsCustomCss: "/admin/settings/custom-css",
      settingsCustomDomain: "/admin/settings/custom-domain",
      settingsCustomDomainValidate: "/admin/settings/custom-domain/validate",
      settingsDashboardType: "/admin/settings/dashboard-type",
      settingsEmail: "/admin/settings/email",
      settingsEmailTemplatesAdmin: "/admin/settings/email-templates/admin",
      settingsEmailTemplatesConfirmation:
        "/admin/settings/email-templates/confirmation",
      settingsEmailTest: "/admin/settings/email/test",
      settingsEmbedHosts: "/admin/settings/embed-hosts",
      settingsExternalOrder: "/admin/settings/external-order",
      settingsGoogleWallet: "/admin/settings/google-wallet",
      settingsHeaderImage: "/admin/settings/header-image",
      settingsHeaderImageDelete: "/admin/settings/header-image/delete",
      settingsHostSubdomain: "/admin/settings/host-subdomain",
      settingsListingColumnOrder: "/admin/settings/listing-column-order",
      settingsListingMode: "/admin/settings/listing-mode",
      settingsLogisticsRunSheet: "/admin/settings/logistics-run-sheet",
      settingsPaymentProvider: "/admin/settings/payment-provider",
      settingsPaymentProviderRecovery:
        "/admin/settings/payment-provider-recovery",
      settingsResetDatabase: "/admin/settings/reset-database",
      settingsShowPublicApi: "/admin/settings/show-public-api",
      settingsSiteFooter: "/admin/settings/site-footer",
      settingsSmsGateway: "/admin/settings/sms-gateway",
      settingsSquare: "/admin/settings/square",
      settingsSquareTest: "/admin/settings/square/test",
      settingsSquareWebhook: "/admin/settings/square-webhook",
      settingsStripe: "/admin/settings/stripe",
      settingsStripeTest: "/admin/settings/stripe/test",
      settingsSumup: "/admin/settings/sumup",
      settingsSumupTest: "/admin/settings/sumup/test",
      settingsSuperuser: "/admin/settings/superuser",
      settingsTax: "/admin/settings/tax",
      settingsTerms: "/admin/settings/terms",
      settingsTheme: "/admin/settings/theme",
      /* jscpd:ignore-end */
    },
  },
  settingsLogistics: recordArea({
    audience: OWNER_AUDIENCE,
    name: "logistics",
    prefix: "logistics",
    singular: "logisticsAgent",
  }),
  settingsStatuses: recordArea({
    audience: OWNER_AUDIENCE,
    basePath: "/admin/settings/statuses",
    extraWrites: {
      ...ORDERED_LISTS.status.writes,
    },
    listAfterSave: false,
    name: "statuses",
    prefix: "status",
    saveToRecord: true,
    singular: "status",
  }),
  site: {
    audience: SITE_ADMIN_LEVELS,
    view: {
      site: "/admin/site",
      siteContact: "/admin/site/contact",
      siteOrder: "/admin/site/order",
      siteReviews: "/admin/site/reviews",
    },
    write: {
      siteContactFormToggle: "/admin/site/contact/form",
      siteOrderToggle: "/admin/site/order/toggle",
    },
  },
  sitePages: recordArea({
    audience: SITE_ADMIN_LEVELS,
    basePath: "/admin/site/pages",
    extraWrites: {
      ...contentWrites("sitePage", "/admin/site/pages/:id"),
      ...ORDERED_LISTS.sitePageImage.writes,
      ...ORDERED_LISTS.sitePageItem.writes,
      sitePageItemRemove:
        "/admin/site/pages/:id/items/:itemType/:itemId/remove",
      sitePageItems: "/admin/site/pages/:id/items",
      ...ORDERED_LISTS.sitePage.writes,
    },
    name: "sitePages",
    prefix: "sitePage",
    singular: "sitePage",
  }),
  support: {
    audience: OWNER_AUDIENCE,
    view: {
      support: { pattern: "/admin/support", readOnlyWrite: "read-only" },
    },
  },
  update: {
    audience: OWNER_AUDIENCE,
    view: {
      update: "/admin/update",
    },
    write: {
      updateCheck: "/admin/update/check",
    },
  },
  users: recordArea({
    audience: OWNER_AUDIENCE,
    editPage: false,
    extraWrites: { userAgents: "/admin/users/:id/agents" },
    name: "users",
    singular: "user",
  }),
  ...onePageAreas(OWNER_AUDIENCE, {
    schemaAtlas: "/admin/schema",
    seeds: "/admin/seeds",
    sessions: "/admin/sessions",
  }),
  ...onePageAreas(STAFF_ADMIN_LEVELS, { sms: "/admin/sms" }),
  // Staff see who subscribed. Only an owner can cancel a subscription.
  subscriptions: {
    audience: STAFF_ADMIN_LEVELS,
    view: { subscriptions: "/admin/subscriptions" },
    write: {
      subscriptionCancel: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/subscriptions/:id/cancel",
      },
    },
  },
} as const;
