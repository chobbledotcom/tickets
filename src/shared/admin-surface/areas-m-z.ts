/**
 * The alphabetical second half of the admin-area registry: the areas from
 * `markdownPreview` through `users`. See `areas.ts` for what a declaration
 * means, and join a new area to the half its name sorts into.
 */

import { OWNER_AUDIENCE } from "#shared/admin-surface/definitions.ts";
import {
  DOOR_ADMIN_LEVELS,
  SITE_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#types";

/** The admin areas from `markdownPreview` through `users`. */
export const AREAS_M_Z = {
  markdownPreview: {
    segments: ["markdown-preview"],
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
    audience: DOOR_ADMIN_LEVELS,
    view: {
      doors: "/admin/scanner",
      groupScanner: "/admin/groups/:id/scanner",
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
} as const;
