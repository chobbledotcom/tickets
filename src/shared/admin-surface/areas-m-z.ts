/**
 * The alphabetical second half of the admin-area registry: the areas from
 * `markdownPreview` through `users`. See `areas.ts` for what a declaration
 * means, and join a new area to the half its name sorts into.
 */

import { OWNER_AUDIENCE } from "#shared/admin-surface/definitions.ts";
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
  modifiers: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      modifier: "/admin/modifiers/:id",
      modifiers: "/admin/modifiers",
    },
    write: {
      modifierAnswers: "/admin/modifiers/:id/answers",
      modifierDelete: "/admin/modifiers/:id/delete",
      modifierEdit: "/admin/modifiers/:id/edit",
      modifierLinks: "/admin/modifiers/:id/links",
      modifierNew: "/admin/modifiers/new",
      modifierRecalculate: "/admin/modifiers/recalculate/:modifierId",
      modifierRevenue: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/modifiers/:id/revenue",
      },
    },
  },
  news: {
    audience: SITE_ADMIN_LEVELS,
    view: {
      news: "/admin/site/news",
      newsPost: "/admin/site/news/:id",
    },
    write: {
      newsActions: "/admin/site/news/:id/actions",
      newsDelete: "/admin/site/news/:id/delete",
      newsEdit: "/admin/site/news/:id/edit",
      newsImages: "/admin/site/news/:id/images",
      newsImagesUpload: "/admin/site/news/:id/images/upload",
      newsNew: "/admin/site/news/new",
    },
  },
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
  questions: {
    audience: OWNER_AUDIENCE,
    segments: ["listing"],
    view: {
      question: "/admin/questions/:id",
      questions: "/admin/questions",
    },
    write: {
      answerAdd: "/admin/questions/:id/answers",
      answerDelete: "/admin/questions/:id/answers/:answerId/delete",
      answerEdit: "/admin/questions/:id/answers/:answerId/edit",
      answerMoveDown: "/admin/questions/:id/answers/:answerId/move-down",
      answerMoveUp: "/admin/questions/:id/answers/:answerId/move-up",
      answerRecalculate: "/admin/questions/:id/answers/:answerId/recalculate",
      questionDelete: "/admin/questions/:id/delete",
      questionEdit: "/admin/questions/:id/edit",
      questionListings: "/admin/questions/:id/listings",
      questionMoveDown: "/admin/questions/:id/move-down",
      questionMoveUp: "/admin/questions/:id/move-up",
    },
  },
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
      groupScan: "/admin/groups/:id/scan",
      listingScan: "/admin/listing/:id/scan",
    },
  },
  schemaAtlas: {
    audience: OWNER_AUDIENCE,
    view: {
      schemaAtlas: "/admin/schema",
    },
  },
  seeds: {
    audience: OWNER_AUDIENCE,
    view: {
      seeds: "/admin/seeds",
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
  sessions: {
    audience: OWNER_AUDIENCE,
    view: {
      sessions: "/admin/sessions",
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
      settingsAddressLookup: "/admin/settings/address-lookup",
      settingsAppleWallet: "/admin/settings/apple-wallet",
      settingsAttendeeColumnOrder: "/admin/settings/attendee-column-order",
      settingsBookingFee: "/admin/settings/booking-fee",
      settingsBusinessEmail: "/admin/settings/business-email",
      settingsCalendarFeeds: "/admin/settings/calendar-feeds",
      settingsCustomCss: "/admin/settings/custom-css",
      settingsCustomDomain: "/admin/settings/custom-domain",
      settingsCustomDomainValidate: "/admin/settings/custom-domain/validate",
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
      settingsTerms: "/admin/settings/terms",
      settingsTheme: "/admin/settings/theme",
    },
  },
  settingsLogistics: {
    audience: OWNER_AUDIENCE,
    view: {
      logistics: "/admin/logistics",
      logisticsAgent: "/admin/logistics/:id",
    },
    write: {
      logisticsDelete: "/admin/logistics/:id/delete",
      logisticsEdit: "/admin/logistics/:id/edit",
      logisticsNew: "/admin/logistics/new",
    },
  },
  settingsStatuses: {
    audience: OWNER_AUDIENCE,
    view: {
      status: "/admin/settings/statuses/:id",
      statuses: "/admin/settings/statuses",
    },
    write: {
      statusDelete: "/admin/settings/statuses/:id/delete",
      statusEdit: "/admin/settings/statuses/:id/edit",
      statusMoveDown: "/admin/settings/statuses/:id/move-down",
      statusMoveUp: "/admin/settings/statuses/:id/move-up",
      statusNew: "/admin/settings/statuses/new",
    },
  },
  site: {
    audience: SITE_ADMIN_LEVELS,
    view: {
      site: "/admin/site",
      siteContact: "/admin/site/contact",
      siteOrder: "/admin/site/order",
    },
    write: {
      siteContactFormToggle: "/admin/site/contact/form",
      siteOrderToggle: "/admin/site/order/toggle",
    },
  },
  sitePages: {
    audience: SITE_ADMIN_LEVELS,
    view: {
      sitePage: "/admin/site/pages/:id",
      sitePages: "/admin/site/pages",
    },
    write: {
      sitePageActions: "/admin/site/pages/:id/actions",
      sitePageDelete: "/admin/site/pages/:id/delete",
      sitePageEdit: "/admin/site/pages/:id/edit",
      sitePageImages: "/admin/site/pages/:id/images",
      sitePageImagesUpload: "/admin/site/pages/:id/images/upload",
      sitePageItemMoveDown:
        "/admin/site/pages/:id/items/:itemType/:itemId/move-down",
      sitePageItemMoveUp:
        "/admin/site/pages/:id/items/:itemType/:itemId/move-up",
      sitePageItemRemove:
        "/admin/site/pages/:id/items/:itemType/:itemId/remove",
      sitePageItems: "/admin/site/pages/:id/items",
      sitePageMoveDown: "/admin/site/pages/:id/move-down",
      sitePageMoveUp: "/admin/site/pages/:id/move-up",
      sitePageNew: "/admin/site/pages/new",
    },
  },
  sms: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      sms: "/admin/sms",
    },
  },
  support: {
    audience: OWNER_AUDIENCE,
    view: {
      support: "/admin/support",
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
  users: {
    audience: OWNER_AUDIENCE,
    view: {
      user: "/admin/users/:id",
      users: "/admin/users",
    },
    write: {
      userAgents: "/admin/users/:id/agents",
      userDelete: "/admin/users/:id/delete",
      userNew: "/admin/user/new",
    },
  },
} as const;
