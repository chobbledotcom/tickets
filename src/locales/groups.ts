import type { MessageGroup } from "#locales/manifest.ts";

/** Copy used by the admin layout itself, independent of the page it wraps. */
export const ADMIN_SHELL_MESSAGE_GROUPS = [
  "activity-log",
  "admin-shell",
  "common",
  "nav",
  "nouns",
] as const satisfies readonly MessageGroup[];

/** Copy used by the public layout and navigation. */
export const PUBLIC_SHELL_MESSAGE_GROUPS = [
  "common",
  "nav",
  "nouns",
] as const satisfies readonly MessageGroup[];

/** Add route-owned copy to the shared public shell. */
export const publicMessageGroups = (
  ...groups: readonly MessageGroup[]
): readonly MessageGroup[] => [...PUBLIC_SHELL_MESSAGE_GROUPS, ...groups];

export const SETUP_MESSAGE_GROUPS = [
  "common",
  "login",
  "setup",
  "validation",
] as const satisfies readonly MessageGroup[];

export const JOIN_MESSAGE_GROUPS = [
  "common",
  "login",
  "validation",
] as const satisfies readonly MessageGroup[];

/** The admin API imports its three resource definitions as one router. */
export const ADMIN_API_MESSAGE_GROUPS = [
  "activity-log",
  "attendees",
  "common",
  "entity-pages",
  "groups",
  "holidays",
  "images",
  "listings-table",
  "modifiers",
  "questions",
  "validation",
] as const satisfies readonly MessageGroup[];

export const PUBLIC_API_MESSAGE_GROUPS = [
  "availability",
  "groups",
  "order",
  "payment",
  "tickets",
  "validation",
] as const satisfies readonly MessageGroup[];
