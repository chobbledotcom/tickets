import { ADMIN_API_MESSAGE_GROUPS } from "#locales/groups.ts";
import { GUIDE_MESSAGE_GROUPS, type MessageGroup } from "#locales/manifest.ts";
import type { AdminAreaId } from "#shared/admin-surface/definitions.ts";

type HandlerMap = Record<string, (...args: never[]) => unknown>;

/** One admin area's lazy routes and message ownership. */
export type AdminAreaLoader = {
  load: () => Promise<HandlerMap>;
  messageGroupsFor: (segment: string) => readonly MessageGroup[];
};

const sameMessageGroups =
  (messageGroups: readonly MessageGroup[]) =>
  (_segment: string): readonly MessageGroup[] =>
    messageGroups;

const messageGroupsBySegment =
  (
    groups: Readonly<Record<string, readonly MessageGroup[]>>,
  ): ((segment: string) => readonly MessageGroup[]) =>
  (segment) => {
    if (!Object.hasOwn(groups, segment)) {
      throw new Error(
        `No message groups declared for admin segment "${segment}"`,
      );
    }
    return groups[segment]!;
  };

/** Declare an area without importing its routes until that area is requested. */
const area = <M extends { adminHandlers: HandlerMap }>(
  load: () => Promise<M>,
  messageGroups: readonly MessageGroup[] = [],
): AdminAreaLoader => ({
  load: async () => (await load()).adminHandlers,
  messageGroupsFor: sameMessageGroups(messageGroups),
});

const guideMessageGroups = messageGroupsBySegment({
  formatting: ["guide-formatting"],
  guide: ["attendees", "builder", "listings-table", ...GUIDE_MESSAGE_GROUPS],
});

// Import specifiers stay literal so esbuild can bundle every target.
export const ADMIN_AREA_LOADERS: Record<AdminAreaId, AdminAreaLoader> = {
  apiKeys: area(
    () => import("#routes/admin/api-keys.ts"),
    [...ADMIN_API_MESSAGE_GROUPS, "users"],
  ),
  attendeeNotes: area(
    () => import("#routes/admin/attendee-notes.ts"),
    [
      "address-lookup",
      "attendees",
      "entity-pages",
      "ledger",
      "logistics",
      "notes",
      "validation",
    ],
  ),
  attendeeRefunds: area(
    () => import("#routes/admin/attendee-refunds.ts"),
    ["attendees", "entity-pages", "ledger", "payment", "validation"],
  ),
  attendees: area(
    () => import("#routes/admin/attendees.ts"),
    [
      "address-lookup",
      "attendees",
      "capacity",
      "csv",
      "date-picker",
      "detail-rows",
      "entity-pages",
      "ledger",
      "listing-qr",
      "listings-table",
      "logistics",
      "modifiers",
      "notes",
      "payment",
      "questions",
      "statuses",
      "validation",
    ],
  ),
  attributes: area(
    () => import("#routes/admin/attributes.ts"),
    ["attributes", "entity-pages", "validation"],
  ),
  auth: area(
    () => import("#routes/admin/auth.ts"),
    ["login", "users", "validation"],
  ),
  backup: area(
    () => import("#routes/admin/backup.ts"),
    ["backup", "validation"],
  ),
  builder: area(
    () => import("#routes/admin/builder.ts"),
    ["builder", "built-sites", "validation"],
  ),
  builtSites: area(
    () => import("#routes/admin/built-sites.ts"),
    ["builder", "built-sites", "entity-pages", "validation"],
  ),
  bulkActions: area(
    () => import("#routes/admin/bulk-actions.ts"),
    ["bulk-actions", "groups", "listings-table", "validation"],
  ),
  bulkEmail: area(
    () => import("#routes/admin/bulk-email.ts"),
    ["attendees", "bulk-email", "validation"],
  ),
  calendar: area(
    () => import("#routes/admin/calendar.ts"),
    [
      "attendees",
      "availability",
      "calendar",
      "capacity",
      "csv",
      "date-picker",
      "detail-rows",
    ],
  ),
  catalogTransfer: area(
    () => import("#routes/admin/catalog-transfer/routes.ts"),
    ["catalog-transfer", "validation"],
  ),
  contactHistory: area(
    () => import("#routes/admin/contact-history.ts"),
    ["attendees", "detail-rows", "privacy"],
  ),
  dashboard: area(
    () => import("#routes/admin/dashboard.ts"),
    [
      "attendees",
      "attributes",
      "availability",
      "capacity",
      "dashboard",
      "holidays",
      "login",
      "listings-table",
      "servicing",
    ],
  ),
  debug: area(() => import("#routes/admin/debug.ts"), ["debug", "settings"]),
  deliveries: area(
    () => import("#routes/admin/deliveries.ts"),
    ["attendees", "capacity", "date-picker", "deliveries", "logistics"],
  ),
  groups: area(
    () => import("#routes/admin/groups.ts"),
    [
      "attendees",
      "capacity",
      "detail-rows",
      "entity-pages",
      "groups",
      "images",
      "listings-table",
      "modifiers",
      "questions",
      "validation",
    ],
  ),
  guide: {
    load: async () => (await import("#routes/admin/guide.ts")).adminHandlers,
    messageGroupsFor: guideMessageGroups,
  },
  holidays: area(
    () => import("#routes/admin/holidays.ts"),
    ["entity-pages", "holidays", "validation"],
  ),
  images: area(
    () => import("#routes/admin/images.ts"),
    ["entity-pages", "images", "validation"],
  ),
  ledger: area(
    () => import("#routes/admin/ledger.ts"),
    [
      "attendees",
      "date-picker",
      "entity-pages",
      "ledger",
      "listings-table",
      "modifiers",
      "servicing",
      "validation",
    ],
  ),
  listingQr: area(
    () => import("#routes/admin/listing-qr.ts"),
    ["listing-qr", "listings-table"],
  ),
  listings: area(
    () => import("#routes/admin/listings.ts"),
    [
      "attendees",
      "attributes",
      "availability",
      "built-sites",
      "capacity",
      "csv",
      "date-picker",
      "deliveries",
      "detail-rows",
      "entity-pages",
      "groups",
      "images",
      "listing-defaults",
      "listing-qr",
      "listings-table",
      "logistics",
      "modifiers",
      "questions",
      "servicing",
      "validation",
    ],
  ),
  markdownPreview: area(() => import("#routes/admin/markdown-preview.ts")),
  modifiers: area(
    () => import("#routes/admin/modifiers.ts"),
    [
      "date-picker",
      "entity-pages",
      "groups",
      "ledger",
      "listings-table",
      "modifiers",
      "validation",
    ],
  ),
  news: area(
    () => import("#routes/admin/news.ts"),
    ["entity-pages", "images", "news", "validation"],
  ),
  privacy: area(
    () => import("#routes/admin/privacy.ts"),
    ["attendees", "privacy"],
  ),
  questions: area(
    () => import("#routes/admin/questions.ts"),
    ["entity-pages", "modifiers", "questions", "validation"],
  ),
  scanner: area(
    () => import("#routes/admin/scanner.ts"),
    ["attendees", "check-in", "listing-qr"],
  ),
  seeds: area(
    () => import("#routes/admin/seeds.ts"),
    ["seed-data", "validation"],
  ),
  servicing: area(
    () => import("#routes/admin/servicing.tsx"),
    ["listings-table", "logistics", "servicing", "validation"],
  ),
  sessions: area(() => import("#routes/admin/sessions.ts"), ["users"]),
  settings: area(
    () => import("#routes/admin/settings.ts"),
    [
      "address-lookup",
      "attendees",
      "calendar",
      "features",
      "images",
      "listing-defaults",
      "listings-table",
      "login",
      "logistics",
      "payment",
      "settings",
      "setup",
      "sms",
      "tickets",
      "users",
      "validation",
    ],
  ),
  settingsLogistics: area(
    () => import("#routes/admin/settings-logistics.ts"),
    ["entity-pages", "logistics", "settings", "users", "validation"],
  ),
  settingsStatuses: area(
    () => import("#routes/admin/settings-statuses.ts"),
    ["entity-pages", "settings", "statuses", "validation"],
  ),
  site: area(
    () => import("#routes/admin/site.ts"),
    ["images", "site", "validation"],
  ),
  sitePages: area(
    () => import("#routes/admin/site-pages.ts"),
    ["entity-pages", "images", "site-pages", "validation"],
  ),
  sms: area(
    () => import("#routes/admin/sms.ts"),
    ["attendees", "sms", "validation"],
  ),
  support: area(
    () => import("#routes/admin/support.ts"),
    ["support", "validation"],
  ),
  update: area(() => import("#routes/admin/update.ts"), ["update"]),
  users: area(
    () => import("#routes/admin/users.ts"),
    ["deliveries", "entity-pages", "login", "users", "validation"],
  ),
};
