/**
 * The alphabetical first half of the admin-area registry: the areas from
 * `apiKeys` through `listings`. See `areas.ts` for what a declaration means,
 * and join a new area to the half its name sorts into.
 */

import {
  OWNER_AUDIENCE,
  onePageAreas,
} from "#shared/admin-surface/definitions.ts";
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
      attendeeCheckin: "/admin/listing/:id/attendee/:attendeeId/checkin",
      attendees: "/admin/attendees",
      attendeesCsv: "/admin/attendees/csv",
    },
    write: {
      attendeeActions: "/admin/attendees/:attendeeId/actions",
      attendeeDelete: "/admin/attendees/:attendeeId/delete",
      attendeeEdit: "/admin/attendees/:attendeeId/edit",
      attendeeLogistics: "/admin/attendees/:attendeeId/logistics",
      attendeeMerge: "/admin/attendees/:attendeeId/merge",
      attendeeNew: "/admin/attendees/new",
      attendeePaymentReview: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/attendees/:attendeeId/payment-review",
      },
      attendeeRefreshPayment: {
        pattern: "/admin/attendees/:attendeeId/refresh-payment",
        readOnlyWrite: "read-only",
      },
      attendeeResend: "/admin/attendees/:attendeeId/resend-notification",
      listingAttendeeAdd: "/admin/listing/:listingId/attendee",
      listingAttendeeCheckin: {
        pattern: "/admin/listing/:listingId/attendee/:attendeeId/checkin",
        readOnlyWrite: "read-only",
      },
      listingAttendeeDeleteIncomplete:
        "/admin/listing/:listingId/attendee/:attendeeId/delete-incomplete",
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
      attributeEdit: "/admin/attributes/:id/edit",
      attributeMoveDown: "/admin/attributes/:id/move-down",
      attributeMoveUp: "/admin/attributes/:id/move-up",
      attributeOptionAdd: "/admin/attributes/:id/options",
      attributeOptionDelete: "/admin/attributes/:id/options/:optionId/delete",
      attributeOptionEdit: "/admin/attributes/:id/options/:optionId/edit",
      attributeOptionMoveDown:
        "/admin/attributes/:id/options/:optionId/move-down",
      attributeOptionMoveUp: "/admin/attributes/:id/options/:optionId/move-up",
    },
  },
  auth: {
    // Signing in and out is how every role reaches, or leaves, the rest.
    audience: ALL_ADMIN_LEVELS,
    view: {
      login: { pattern: "/admin/login", readOnlyWrite: "always" },
      logout: { pattern: "/admin/logout", readOnlyWrite: "always" },
    },
  },
  backup: {
    audience: OWNER_AUDIENCE,
    view: {
      backup: "/admin/backup",
      backupDownload: "/admin/backup/download/:filename",
    },
    write: {
      backupCreate: {
        pattern: "/admin/backup/create",
        readOnlyWrite: "read-only",
      },
    },
  },
  builtSites: {
    audience: OWNER_AUDIENCE,
    view: {
      builtSite: "/admin/built-sites/:id",
      builtSites: { afterSave: "builtSite", pattern: "/admin/built-sites" },
    },
    write: {
      builtSiteAddSecrets: "/admin/built-sites/:id/add-secrets",
      builtSiteAddUptimeMonitor: "/admin/built-sites/:id/add-uptime-monitor",
      builtSiteBumpDeadline: "/admin/built-sites/:id/bump-deadline",
      builtSiteCompleteDatabaseKeyRotation: {
        // The timer page's meta refresh opens this GET, so read-only mode
        // keeps serving it instead of redirecting it.
        pattern: "/admin/built-sites/:id/rotate-database-key/complete",
        readOnlyGet: true,
      },
      builtSiteDelete: "/admin/built-sites/:id/delete",
      builtSiteEdit: {
        afterSave: "builtSite",
        pattern: "/admin/built-sites/:id/edit",
      },
      builtSiteNew: "/admin/built-sites/new",
      builtSiteOverrideDeadline: "/admin/built-sites/:id/override-deadline",
      builtSiteProvisionRenewal: "/admin/built-sites/:id/provision-renewal",
      builtSiteProvisionScheduler: "/admin/built-sites/:id/provision-scheduler",
      builtSiteReSyncDeadline: "/admin/built-sites/:id/re-sync-deadline",
      builtSiteRotateDatabaseKey: {
        // The POST's redirect opens this GET, which carries the timer page's
        // signed link, so read-only mode keeps serving it.
        pattern: "/admin/built-sites/:id/rotate-database-key",
        readOnlyGet: true,
      },
      builtSiteRotateRenewalToken:
        "/admin/built-sites/:id/rotate-renewal-token",
      builtSiteSupportMessage: {
        // The tab renders the stored message for a read-only viewer, so
        // read-only mode keeps serving the route's GET.
        pattern: "/admin/built-sites/:id/support-message",
        readOnlyGet: true,
      },
      builtSiteUpdate: "/admin/built-sites/:id/update",
    },
  },
  bulkEmail: {
    audience: OWNER_AUDIENCE,
    view: {
      emailPreview: "/admin/emails/preview",
      emails: "/admin/emails",
    },
    write: {
      emailSend: "/admin/emails/send",
      emailTemplateDelete: "/admin/emails/templates/:id/delete",
      emailTemplateSave: "/admin/emails/templates",
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
  dashboard: {
    audience: STAFF_ADMIN_LEVELS,
    // The welcome-dismiss POST renders no page of its own. Its handler gates
    // the owner role and the CSRF token itself.
    segments: ["welcome"],
    view: {
      home: "/admin/",
      listings: { audience: CONTENT_ADMIN_LEVELS, pattern: "/admin/listings" },
      listingsCsv: "/admin/listings/csv",
      log: "/admin/log",
    },
    write: {
      welcomeDismiss: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/welcome/dismiss",
      },
    },
  },
  debug: {
    audience: OWNER_AUDIENCE,
    view: {
      debug: "/admin/debug",
    },
    write: {
      debugSentry: {
        pattern: "/admin/debug/sentry",
        readOnlyWrite: "read-only",
      },
    },
  },
  deliveries: {
    // The run sheet is a delivery agent's only page, so it admits agents as
    // well as staff — the same roles `deliveryPage` lets through.
    audience: DELIVERY_ADMIN_LEVELS,
    view: {
      deliveries: "/admin/deliveries",
    },
    write: {
      deliveriesMark: {
        pattern: "/admin/deliveries/mark",
        readOnlyWrite: "read-only",
      },
    },
  },
  // The group-wide actions the group page's Actions tab links to. Each writes
  // the group's member listings, so each stays staff-only.
  groupActions: {
    audience: STAFF_ADMIN_LEVELS,
    write: {
      groupDeactivate: "/admin/groups/:id/deactivate",
      groupDuplicate: "/admin/groups/:id/duplicate",
      groupReactivate: "/admin/groups/:id/reactivate",
    },
  },
  groups: {
    audience: CONTENT_ADMIN_LEVELS,
    view: {
      // A record page opens on the first tab its viewer can see, so an editor
      // reaches it and lands on Edit. The staff-only tabs stay shut.
      group: "/admin/groups/:id",
      groups: { afterSave: "group", pattern: "/admin/groups" },
    },
    write: {
      groupAddListings: "/admin/groups/:id/add-listings",
      groupDelete: {
        audience: STAFF_ADMIN_LEVELS,
        pattern: "/admin/groups/:id/delete",
      },
      groupEdit: { afterSave: "group", pattern: "/admin/groups/:id/edit" },
      groupImages: "/admin/groups/:id/images",
      groupImagesUpload: "/admin/groups/:id/images/upload",
      groupNew: "/admin/groups/new",
      groupNote: {
        audience: STAFF_ADMIN_LEVELS,
        pattern: "/admin/groups/:id/note",
      },
      groupNoteDelete: {
        audience: STAFF_ADMIN_LEVELS,
        pattern: "/admin/groups/:id/note/:noteId/delete",
      },
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
      holidays: { afterSave: "holiday", pattern: "/admin/holidays" },
    },
    write: {
      holidayDelete: "/admin/holidays/:id/delete",
      holidayEdit: {
        afterSave: "holiday",
        pattern: "/admin/holidays/:id/edit",
      },
      holidayNew: "/admin/holidays/new",
    },
  },
  images: {
    audience: CONTENT_ADMIN_LEVELS,
    view: {
      imageOptions: "/admin/images/options",
      images: "/admin/images",
    },
    write: {
      imageDelete: "/admin/images/:id/delete",
      imageEdit: "/admin/images/:id/edit",
      imageNew: "/admin/images/new",
    },
  },
  // Staff only: an invoice can be created only by an owner or a manager.
  invoices: {
    audience: STAFF_ADMIN_LEVELS,
    view: {
      invoice: "/admin/invoices/:id",
      invoices: "/admin/invoices",
    },
    write: {
      invoiceCancel: "/admin/invoices/:id/cancel",
      invoiceDelete: "/admin/invoices/:id/delete",
      invoiceNew: "/admin/invoices/new",
      invoicePreview: "/admin/invoices/preview",
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
      ledgerEntryDelete: "/admin/ledger/entries/:id/delete",
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
      listingAttachmentDelete: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/attachment/delete",
      },
      listingAttributes: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/listing/:id/attributes",
      },
      listingChildren: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/children",
      },
      listingCreate: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing",
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
      listingImagesUpload: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/:id/images/upload",
      },
      listingIncome: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/listing/:id/income",
      },
      listingNew: {
        audience: CONTENT_ADMIN_LEVELS,
        pattern: "/admin/listing/new",
      },
      listingNote: "/admin/listing/:id/note",
      listingNoteDelete: "/admin/listing/:id/note/:noteId/delete",
      listingQr: "/admin/listing/:id/qr",
      listingQuestions: {
        audience: OWNER_AUDIENCE,
        pattern: "/admin/listing/:id/questions",
      },
      listingReactivate: "/admin/listing/:id/reactivate",
      listingRecalculate: "/admin/listings/recalculate/:listingId",
    },
  },
  ...onePageAreas(OWNER_AUDIENCE, {
    builder: "/admin/builder",
    // The owner's read-only view of where their records also appear. The
    // admin API writes this directory. The page only shows what the database
    // holds.
    externalSources: "/admin/external-sources",
  }),
  ...onePageAreas(STAFF_ADMIN_LEVELS, {
    contactHistory: "/admin/history/:hmac",
  }),
} as const;
