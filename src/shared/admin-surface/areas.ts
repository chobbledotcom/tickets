/**
 * Every admin area, and the routes it serves.
 *
 * This is the one place an admin route is declared. The nav that links to a
 * route lives in `sections.ts`; the module that serves it lives in
 * `src/features/admin/area-loaders.ts`, keyed by the same area names.
 *
 * An area names the role that reaches it once. A route names a role only when
 * it differs from its area. `segments` lists a URL segment the area serves
 * without a page of its own, such as a POST-only endpoint.
 */

import {
  type AdminAreasSpec,
  OWNER_AUDIENCE,
} from "#shared/admin-surface/definitions.ts";
import {
  ALL_ADMIN_LEVELS,
  CONTENT_ADMIN_LEVELS,
  DELIVERY_ADMIN_LEVELS,
  SITE_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#types";

export const ADMIN_AREAS = {
  apiKeys: {
    audience: OWNER_AUDIENCE,
    view: {
      apiKey: "/admin/api-keys/:apiKeyId",
      apiKeyDocs: "/admin/api-keys/docs",
      apiKeys: "/admin/api-keys",
    },
    write: {
      apiKeyDelete: "/admin/api-keys/:apiKeyId/delete",
    },
  },
  attendeeNotes: {
    audience: STAFF_ADMIN_LEVELS,
    write: {
      attendeeNote: "/admin/attendee/:attendeeId/note",
      attendeeNoteDelete: "/admin/attendee/:attendeeId/note/:noteId/delete",
    },
  },
  attendeeRefunds: {
    audience: OWNER_AUDIENCE,
    write: {
      attendeeRefund: "/admin/attendees/:attendeeId/refund",
      listingRefundAll: "/admin/listing/:id/refund-all",
    },
  },
  attendees: {
    audience: STAFF_ADMIN_LEVELS,
    segments: ["listing"],
    view: {
      attendee: "/admin/attendees/:attendeeId",
      attendees: "/admin/attendees",
      attendeesCsv: "/admin/attendees/csv",
    },
    write: {
      attendeeActions: "/admin/attendees/:attendeeId/actions",
      attendeeDelete: "/admin/attendees/:attendeeId/delete",
      attendeeEdit: "/admin/attendees/:attendeeId/edit",
      attendeeLogistics: "/admin/attendees/:attendeeId/logistics",
      attendeeNew: "/admin/attendees/new",
      attendeePaymentReview: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/attendees/:attendeeId/payment-review",
      },
      attendeeResend: "/admin/attendees/:attendeeId/resend-notification",
    },
  },
  attributes: {
    audience: OWNER_AUDIENCE,
    segments: ["listing"],
    view: {
      attribute: "/admin/attributes/:id",
      attributes: "/admin/attributes",
    },
    write: {
      attributeDelete: "/admin/attributes/:id/delete",
      attributeOptionDelete: "/admin/attributes/:id/options/:optionId/delete",
      attributeOptionEdit: "/admin/attributes/:id/options/:optionId/edit",
    },
  },
  auth: {
    // Signing in and out is how every role reaches, or leaves, the rest.
    audience: ALL_ADMIN_LEVELS,
    view: {
      login: "/admin/login",
      logout: "/admin/logout",
    },
  },
  backup: {
    audience: OWNER_AUDIENCE,
    view: {
      backup: "/admin/backup",
      backupDownload: "/admin/backup/download/:filename",
    },
  },
  builder: {
    audience: OWNER_AUDIENCE,
    view: {
      builder: "/admin/builder",
    },
  },
  builtSites: {
    audience: OWNER_AUDIENCE,
    view: {
      builtSite: "/admin/built-sites/:id",
      builtSites: "/admin/built-sites",
    },
    write: {
      builtSiteDelete: "/admin/built-sites/:id/delete",
      builtSiteEdit: "/admin/built-sites/:id/edit",
      builtSiteNew: "/admin/built-sites/new",
    },
  },
  bulkActions: {
    audience: STAFF_ADMIN_LEVELS,
    write: {
      bulkActions: "/admin/groups/:id/bulk-actions",
      bulkDeactivate: "/admin/groups/:id/bulk-actions/deactivate",
      bulkDuplicate: "/admin/groups/:id/bulk-actions/duplicate",
      bulkReactivate: "/admin/groups/:id/bulk-actions/reactivate",
    },
  },
  bulkEmail: {
    audience: OWNER_AUDIENCE,
    view: {
      emailPreview: "/admin/emails/preview",
      emails: "/admin/emails",
    },
    write: {
      emailTemplateDelete: "/admin/emails/templates/:id/delete",
    },
  },
  calendar: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      calendar: "/admin/calendar",
      calendarExport: "/admin/calendar/export",
    },
  },
  catalogTransfer: {
    audience: CONTENT_ADMIN_LEVELS,
    view: {
      groupExportJson: "/admin/groups/:id/export.json",
      listingExportJson: "/admin/listing/:id/export.json",
    },
    write: {
      catalogImport: "/admin/catalog/import",
    },
  },
  contactHistory: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      contactHistory: "/admin/history/:hmac",
    },
  },
  dashboard: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      home: "/admin/",
      listings: { audience: CONTENT_ADMIN_LEVELS, pattern: "/admin/listings" },
      listingsCsv: "/admin/listings/csv",
      log: "/admin/log",
    },
  },
  debug: {
    audience: OWNER_AUDIENCE,
    view: {
      debug: "/admin/debug",
    },
  },
  deliveries: {
    // The run sheet is a delivery agent's only page, so it admits agents as
    // well as staff — the same roles `deliveryPage` lets through.
    audience: DELIVERY_ADMIN_LEVELS,
    view: {
      deliveries: "/admin/deliveries",
    },
  },
  groups: {
    audience: CONTENT_ADMIN_LEVELS,
    view: {
      // A record page opens on the first tab its viewer can see, so an editor
      // reaches it and lands on Edit. The staff-only tabs stay shut.
      group: "/admin/groups/:id",
      groups: "/admin/groups",
    },
    write: {
      groupDelete: {
        audience: STAFF_ADMIN_LEVELS,
        pattern: "/admin/groups/:id/delete",
      },
      groupEdit: "/admin/groups/:id/edit",
      groupImages: "/admin/groups/:id/images",
      groupNew: "/admin/groups/new",
    },
  },
  guide: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      formatting: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/formatting",
      },
      guide: "/admin/guide",
    },
  },
  holidays: {
    audience: OWNER_AUDIENCE,
    view: {
      holiday: "/admin/holidays/:id",
      holidays: "/admin/holidays",
    },
    write: {
      holidayDelete: "/admin/holidays/:id/delete",
      holidayEdit: "/admin/holidays/:id/edit",
      holidayNew: "/admin/holidays/new",
    },
  },
  images: {
    audience: CONTENT_ADMIN_LEVELS,
    view: {
      images: "/admin/images",
    },
    write: {
      imageDelete: "/admin/images/:id/delete",
      imageEdit: "/admin/images/:id/edit",
      imageNew: "/admin/images/new",
    },
  },
  ledger: {
    audience: OWNER_AUDIENCE,
    view: {
      ledger: "/admin/ledger",
      ledgerAccount: "/admin/ledger/:type/:ref",
    },
    write: {
      ledgerAdd: "/admin/ledger/:type/:ref/add",
      ledgerEdit: "/admin/ledger/entries/:id/edit",
    },
  },
  listingQr: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      listingQrJson: "/admin/listing/:id/qr.json",
    },
  },
  listings: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      // A record page opens on the first tab its viewer can see, so an editor
      // reaches it and lands on Edit. The staff-only tabs stay shut.
      listing: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id",
      },
      listingAttendeesCsv: "/admin/listing/:id/attendees.csv",
      listingExport: "/admin/listing/:id/export",
    },
    write: {
      listingAttributes: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/listing/:id/attributes",
      },
      listingDeactivate: "/admin/listing/:id/deactivate",
      listingDelete: "/admin/listing/:id/delete",
      listingDuplicate: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/duplicate",
      },
      listingEdit: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/edit",
      },
      listingImages: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/images",
      },
      listingNew: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/new",
      },
      listingQr: "/admin/listing/:id/qr",
      listingQuestions: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/listing/:id/questions",
      },
      listingReactivate: "/admin/listing/:id/reactivate",
      listingRecalculate: "/admin/listings/recalculate/:listingId",
    },
  },
  markdownPreview: {
    segments: ["markdown-preview"],
  },
  modifiers: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      modifier: "/admin/modifiers/:id",
      modifiers: "/admin/modifiers",
    },
    write: {
      modifierDelete: "/admin/modifiers/:id/delete",
      modifierEdit: "/admin/modifiers/:id/edit",
      modifierNew: "/admin/modifiers/new",
      modifierRecalculate: "/admin/modifiers/recalculate/:modifierId",
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
      newsNew: "/admin/site/news/new",
    },
  },
  privacy: {
    audience: OWNER_AUDIENCE,
    view: {
      privacy: "/admin/privacy",
      privacyRefund: "/admin/privacy/refunds/:id",
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
      answerDelete: "/admin/questions/:id/answers/:answerId/delete",
      answerEdit: "/admin/questions/:id/answers/:answerId/edit",
      answerRecalculate: "/admin/questions/:id/answers/:answerId/recalculate",
      questionDelete: "/admin/questions/:id/delete",
    },
  },
  scanner: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      listingScanner: "/admin/listing/:id/scanner",
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
      sitePageItems: "/admin/site/pages/:id/items",
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
} as const satisfies AdminAreasSpec;
