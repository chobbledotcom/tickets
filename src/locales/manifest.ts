import system from "./en/system.json" with { type: "json" };

export type Messages = Readonly<Record<string, string>>;
export type MessageLoader = () => Promise<Messages>;

export const MESSAGE_GROUPS = [
  "address-lookup",
  "activity-log",
  "admin-shell",
  "attendees",
  "attributes",
  "availability",
  "backup",
  "builder",
  "built-sites",
  "bulk-actions",
  "bulk-email",
  "calendar",
  "capacity",
  "catalog-transfer",
  "check-in",
  "common",
  "contact",
  "csv",
  "dashboard",
  "date-picker",
  "debug",
  "deliveries",
  "detail-rows",
  "entity-pages",
  "features",
  "groups",
  "guide",
  "guide-accounts",
  "guide-domains",
  "guide-email",
  "guide-formatting",
  "guide-getting-started",
  "guide-import-export",
  "guide-integrations",
  "guide-listings",
  "guide-operations",
  "guide-payments",
  "guide-tickets",
  "holidays",
  "images",
  "ledger",
  "listing-defaults",
  "listing-qr",
  "listings-table",
  "login",
  "logistics",
  "modifiers",
  "nav",
  "news",
  "notes",
  "nouns",
  "order",
  "payment",
  "privacy",
  "public-site",
  "questions",
  "renewal",
  "seed-data",
  "servicing",
  "settings",
  "schema-atlas",
  "setup",
  "site",
  "site-pages",
  "sms",
  "statuses",
  "support",
  "system",
  "tickets",
  "unsubscribe",
  "update",
  "users",
  "validation",
] as const;

export type MessageGroup = (typeof MESSAGE_GROUPS)[number];
type GuideMessageGroup = Extract<MessageGroup, "guide" | `guide-${string}`>;

export const GUIDE_MESSAGE_GROUPS: readonly GuideMessageGroup[] =
  MESSAGE_GROUPS.filter(
    (group): group is GuideMessageGroup =>
      group === "guide" || group.startsWith("guide-"),
  );

type MessageModule = { default: Messages };

const messagesFrom =
  (load: () => Promise<MessageModule>): MessageLoader =>
  async () =>
    (await load()).default;

// Literal import paths keep every JSON file in its own lazy esbuild initializer.
export const ENGLISH_MESSAGE_LOADERS: Record<MessageGroup, MessageLoader> = {
  "activity-log": messagesFrom(
    () => import("./en/activity-log.json", { with: { type: "json" } }),
  ),
  "address-lookup": messagesFrom(
    () => import("./en/address-lookup.json", { with: { type: "json" } }),
  ),
  "admin-shell": messagesFrom(
    () => import("./en/admin-shell.json", { with: { type: "json" } }),
  ),
  attendees: messagesFrom(
    () => import("./en/attendees.json", { with: { type: "json" } }),
  ),
  attributes: messagesFrom(
    () => import("./en/attributes.json", { with: { type: "json" } }),
  ),
  availability: messagesFrom(
    () => import("./en/availability.json", { with: { type: "json" } }),
  ),
  backup: messagesFrom(
    () => import("./en/backup.json", { with: { type: "json" } }),
  ),
  builder: messagesFrom(
    () => import("./en/builder.json", { with: { type: "json" } }),
  ),
  "built-sites": messagesFrom(
    () => import("./en/built-sites.json", { with: { type: "json" } }),
  ),
  "bulk-actions": messagesFrom(
    () => import("./en/bulk-actions.json", { with: { type: "json" } }),
  ),
  "bulk-email": messagesFrom(
    () => import("./en/bulk-email.json", { with: { type: "json" } }),
  ),
  calendar: messagesFrom(
    () => import("./en/calendar.json", { with: { type: "json" } }),
  ),
  capacity: messagesFrom(
    () => import("./en/capacity.json", { with: { type: "json" } }),
  ),
  "catalog-transfer": messagesFrom(
    () => import("./en/catalog-transfer.json", { with: { type: "json" } }),
  ),
  "check-in": messagesFrom(
    () => import("./en/check-in.json", { with: { type: "json" } }),
  ),
  common: messagesFrom(
    () => import("./en/common.json", { with: { type: "json" } }),
  ),
  contact: messagesFrom(
    () => import("./en/contact.json", { with: { type: "json" } }),
  ),
  csv: messagesFrom(() => import("./en/csv.json", { with: { type: "json" } })),
  dashboard: messagesFrom(
    () => import("./en/dashboard.json", { with: { type: "json" } }),
  ),
  "date-picker": messagesFrom(
    () => import("./en/date-picker.json", { with: { type: "json" } }),
  ),
  debug: messagesFrom(
    () => import("./en/debug.json", { with: { type: "json" } }),
  ),
  deliveries: messagesFrom(
    () => import("./en/deliveries.json", { with: { type: "json" } }),
  ),
  "detail-rows": messagesFrom(
    () => import("./en/detail-rows.json", { with: { type: "json" } }),
  ),
  "entity-pages": messagesFrom(
    () => import("./en/entity-pages.json", { with: { type: "json" } }),
  ),
  features: messagesFrom(
    () => import("./en/features.json", { with: { type: "json" } }),
  ),
  groups: messagesFrom(
    () => import("./en/groups.json", { with: { type: "json" } }),
  ),
  guide: messagesFrom(
    () => import("./en/guide.json", { with: { type: "json" } }),
  ),
  "guide-accounts": messagesFrom(
    () => import("./en/guide-accounts.json", { with: { type: "json" } }),
  ),
  "guide-domains": messagesFrom(
    () => import("./en/guide-domains.json", { with: { type: "json" } }),
  ),
  "guide-email": messagesFrom(
    () => import("./en/guide-email.json", { with: { type: "json" } }),
  ),
  "guide-formatting": messagesFrom(
    () => import("./en/guide-formatting.json", { with: { type: "json" } }),
  ),
  "guide-getting-started": messagesFrom(
    () => import("./en/guide-getting-started.json", { with: { type: "json" } }),
  ),
  "guide-import-export": messagesFrom(
    () => import("./en/guide-import-export.json", { with: { type: "json" } }),
  ),
  "guide-integrations": messagesFrom(
    () => import("./en/guide-integrations.json", { with: { type: "json" } }),
  ),
  "guide-listings": messagesFrom(
    () => import("./en/guide-listings.json", { with: { type: "json" } }),
  ),
  "guide-operations": messagesFrom(
    () => import("./en/guide-operations.json", { with: { type: "json" } }),
  ),
  "guide-payments": messagesFrom(
    () => import("./en/guide-payments.json", { with: { type: "json" } }),
  ),
  "guide-tickets": messagesFrom(
    () => import("./en/guide-tickets.json", { with: { type: "json" } }),
  ),
  holidays: messagesFrom(
    () => import("./en/holidays.json", { with: { type: "json" } }),
  ),
  images: messagesFrom(
    () => import("./en/images.json", { with: { type: "json" } }),
  ),
  ledger: messagesFrom(
    () => import("./en/ledger.json", { with: { type: "json" } }),
  ),
  "listing-defaults": messagesFrom(
    () => import("./en/listing-defaults.json", { with: { type: "json" } }),
  ),
  "listing-qr": messagesFrom(
    () => import("./en/listing-qr.json", { with: { type: "json" } }),
  ),
  "listings-table": messagesFrom(
    () => import("./en/listings-table.json", { with: { type: "json" } }),
  ),
  login: messagesFrom(
    () => import("./en/login.json", { with: { type: "json" } }),
  ),
  logistics: messagesFrom(
    () => import("./en/logistics.json", { with: { type: "json" } }),
  ),
  modifiers: messagesFrom(
    () => import("./en/modifiers.json", { with: { type: "json" } }),
  ),
  nav: messagesFrom(() => import("./en/nav.json", { with: { type: "json" } })),
  news: messagesFrom(
    () => import("./en/news.json", { with: { type: "json" } }),
  ),
  notes: messagesFrom(
    () => import("./en/notes.json", { with: { type: "json" } }),
  ),
  nouns: messagesFrom(
    () => import("./en/nouns.json", { with: { type: "json" } }),
  ),
  order: messagesFrom(
    () => import("./en/order.json", { with: { type: "json" } }),
  ),
  payment: messagesFrom(
    () => import("./en/payment.json", { with: { type: "json" } }),
  ),
  privacy: messagesFrom(
    () => import("./en/privacy.json", { with: { type: "json" } }),
  ),
  "public-site": messagesFrom(
    () => import("./en/public-site.json", { with: { type: "json" } }),
  ),
  questions: messagesFrom(
    () => import("./en/questions.json", { with: { type: "json" } }),
  ),
  renewal: messagesFrom(
    () => import("./en/renewal.json", { with: { type: "json" } }),
  ),
  "schema-atlas": messagesFrom(
    () => import("./en/schema-atlas.json", { with: { type: "json" } }),
  ),
  "seed-data": messagesFrom(
    () => import("./en/seed-data.json", { with: { type: "json" } }),
  ),
  servicing: messagesFrom(
    () => import("./en/servicing.json", { with: { type: "json" } }),
  ),
  settings: messagesFrom(
    () => import("./en/settings.json", { with: { type: "json" } }),
  ),
  setup: messagesFrom(
    () => import("./en/setup.json", { with: { type: "json" } }),
  ),
  site: messagesFrom(
    () => import("./en/site.json", { with: { type: "json" } }),
  ),
  "site-pages": messagesFrom(
    () => import("./en/site-pages.json", { with: { type: "json" } }),
  ),
  sms: messagesFrom(() => import("./en/sms.json", { with: { type: "json" } })),
  statuses: messagesFrom(
    () => import("./en/statuses.json", { with: { type: "json" } }),
  ),
  support: messagesFrom(
    () => import("./en/support.json", { with: { type: "json" } }),
  ),
  system: async () => system,
  tickets: messagesFrom(
    () => import("./en/tickets.json", { with: { type: "json" } }),
  ),
  unsubscribe: messagesFrom(
    () => import("./en/unsubscribe.json", { with: { type: "json" } }),
  ),
  update: messagesFrom(
    () => import("./en/update.json", { with: { type: "json" } }),
  ),
  users: messagesFrom(
    () => import("./en/users.json", { with: { type: "json" } }),
  ),
  validation: messagesFrom(
    () => import("./en/validation.json", { with: { type: "json" } }),
  ),
};

export const SYSTEM_MESSAGES: Messages = system;
