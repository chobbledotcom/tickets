import system from "./en/system.json" with { type: "json" };

export type Messages = Readonly<Record<string, string>>;
export type MessageLoader = () => Promise<Messages>;

export const MESSAGE_GROUPS = [
  "address-lookup",
  "admin",
  "attendees",
  "attributes",
  "availability",
  "backup",
  "builder",
  "built-sites",
  "bulk-actions",
  "bulk-email",
  "capacity",
  "catalog-transfer",
  "common",
  "csv",
  "date-picker",
  "debug",
  "deliveries",
  "detail-rows",
  "entity-pages",
  "errors",
  "features",
  "fields",
  "groups",
  "guide",
  "holidays",
  "images",
  "listing-defaults",
  "listing-qr",
  "listings-table",
  "login",
  "logistics",
  "modifiers",
  "nav",
  "news",
  "notes",
  "payment",
  "privacy",
  "public",
  "questions",
  "servicing",
  "settings",
  "setup",
  "site",
  "site-pages",
  "sms",
  "statuses",
  "support",
  "system",
  "terms",
  "tickets",
  "update",
  "users",
] as const;

export type MessageGroup = (typeof MESSAGE_GROUPS)[number];

type MessageModule = { default: Messages };

const messagesFrom =
  (load: () => Promise<MessageModule>): MessageLoader =>
  async () =>
    (await load()).default;

// Literal import paths keep every JSON file in its own lazy esbuild initializer.
export const ENGLISH_MESSAGE_LOADERS: Record<MessageGroup, MessageLoader> = {
  "address-lookup": messagesFrom(
    () => import("./en/address-lookup.json", { with: { type: "json" } }),
  ),
  admin: messagesFrom(
    () => import("./en/admin.json", { with: { type: "json" } }),
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
  capacity: messagesFrom(
    () => import("./en/capacity.json", { with: { type: "json" } }),
  ),
  "catalog-transfer": messagesFrom(
    () => import("./en/catalog-transfer.json", { with: { type: "json" } }),
  ),
  common: messagesFrom(
    () => import("./en/common.json", { with: { type: "json" } }),
  ),
  csv: messagesFrom(() => import("./en/csv.json", { with: { type: "json" } })),
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
  errors: messagesFrom(
    () => import("./en/errors.json", { with: { type: "json" } }),
  ),
  features: messagesFrom(
    () => import("./en/features.json", { with: { type: "json" } }),
  ),
  fields: messagesFrom(
    () => import("./en/fields.json", { with: { type: "json" } }),
  ),
  groups: messagesFrom(
    () => import("./en/groups.json", { with: { type: "json" } }),
  ),
  guide: messagesFrom(
    () => import("./en/guide.json", { with: { type: "json" } }),
  ),
  holidays: messagesFrom(
    () => import("./en/holidays.json", { with: { type: "json" } }),
  ),
  images: messagesFrom(
    () => import("./en/images.json", { with: { type: "json" } }),
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
  payment: messagesFrom(
    () => import("./en/payment.json", { with: { type: "json" } }),
  ),
  privacy: messagesFrom(
    () => import("./en/privacy.json", { with: { type: "json" } }),
  ),
  public: messagesFrom(
    () => import("./en/public.json", { with: { type: "json" } }),
  ),
  questions: messagesFrom(
    () => import("./en/questions.json", { with: { type: "json" } }),
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
  terms: messagesFrom(
    () => import("./en/terms.json", { with: { type: "json" } }),
  ),
  tickets: messagesFrom(
    () => import("./en/tickets.json", { with: { type: "json" } }),
  ),
  update: messagesFrom(
    () => import("./en/update.json", { with: { type: "json" } }),
  ),
  users: messagesFrom(
    () => import("./en/users.json", { with: { type: "json" } }),
  ),
};

export const SYSTEM_MESSAGES: Messages = system;
