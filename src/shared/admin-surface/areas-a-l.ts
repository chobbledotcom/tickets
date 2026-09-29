/**
 * The alphabetical first half of the admin-area registry: the areas from
 * `apiKeys` through `listings`. See `areas.ts` for what a declaration means,
 * and join a new area to the half its name sorts into.
 */

import { OWNER_AUDIENCE } from "#shared/admin-surface/definitions.ts";
import {
  ALL_ADMIN_LEVELS,
  CONTENT_ADMIN_LEVELS,
  DELIVERY_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#types";

/** The admin areas from `apiKeys` through `listings`. */
export const AREAS_A_L = {
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
    view: { builder: "/admin/builder" },
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
      groupRemoveListings: "/admin/groups/:id/remove-listings",
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
} as const;
