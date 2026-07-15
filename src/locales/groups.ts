import { MESSAGE_GROUPS, type MessageGroup } from "#locales/manifest.ts";

const ADMIN_AREA_MESSAGE_GROUPS = [
  "backup",
  "builder",
  "bulk-actions",
  "bulk-email",
  "debug",
  "deliveries",
  "groups",
  "guide",
  "notes",
  "privacy",
  "servicing",
  "support",
  "update",
] as const satisfies readonly MessageGroup[];

export type AdminAreaMessageGroup = (typeof ADMIN_AREA_MESSAGE_GROUPS)[number];

const NON_ADMIN_BASE_GROUPS: ReadonlySet<MessageGroup> = new Set([
  ...ADMIN_AREA_MESSAGE_GROUPS,
  "setup",
  "system",
]);

/** Copy shared by every real admin page. Area-only catalogs are declared with
 * their lazy area loader, so an unrelated admin segment never initializes them. */
export const ADMIN_BASE_MESSAGE_GROUPS: readonly MessageGroup[] =
  MESSAGE_GROUPS.filter((group) => !NON_ADMIN_BASE_GROUPS.has(group));

export const PUBLIC_MESSAGE_GROUPS = [
  "address-lookup",
  "availability",
  "common",
  "errors",
  "fields",
  "listing-qr",
  "listings-table",
  "modifiers",
  "nav",
  "news",
  "payment",
  "public",
  "terms",
  "tickets",
] as const satisfies readonly MessageGroup[];

export const SETUP_MESSAGE_GROUPS = [
  "common",
  "errors",
  "fields",
  "setup",
] as const satisfies readonly MessageGroup[];

export const JOIN_MESSAGE_GROUPS = [
  "common",
  "errors",
  "fields",
  "login",
] as const satisfies readonly MessageGroup[];

export const API_MESSAGE_GROUPS = [
  ...ADMIN_BASE_MESSAGE_GROUPS,
  "groups",
] as const satisfies readonly MessageGroup[];
