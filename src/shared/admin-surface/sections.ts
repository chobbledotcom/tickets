/**
 * The admin navigation: which sections the sidebar shows, and which routes sit
 * under each one, in the order a reader sees them.
 *
 * A section names its routes by id. The route itself — its pattern and the
 * role that reaches it — is declared once in `areas.ts`. A link here can
 * never point somewhere its target refuses.
 */

import type { AdminFeatureKey } from "#shared/admin-features.ts";
import {
  type AdminNavKind,
  type AdminSurfaceContext,
  featureVisible,
} from "#shared/admin-surface/definitions.ts";
import type {
  AdminDestinationId,
  AdminRecordDestinationId,
} from "#shared/admin-surface/ids.ts";
import type { AdminLevel } from "#types";

export type AdminNavEntry = {
  readonly id: AdminDestinationId;
  readonly kind: AdminNavKind;
  readonly labelKey: string;
  readonly visible?: (ctx: AdminSurfaceContext) => boolean;
};

export type AdminSectionDef = {
  /** The page for one of this section's records, where a link from the list
   * and a redirect after a save both land. */
  readonly detail?: AdminRecordDestinationId;
  readonly id: string;
  readonly labelKey: string;
  readonly landing: AdminDestinationId;
  /** The route a named role lands on after sign-in, when that page is a nav
   * child of this section. The role must be able to open the route it names. */
  readonly landingFor?: Readonly<
    Partial<Record<AdminLevel, AdminDestinationId>>
  >;
  readonly nav: readonly AdminNavEntry[];
  readonly visible?: (ctx: AdminSurfaceContext) => boolean;
};

/** A site fact that hides a section or link, on top of the role check. */
type SiteCondition = "builder" | "scanner" | "storage" | "support";

/** When a section or link shows: while a feature is on, or while a site fact
 * holds. */
type NavCondition = { readonly feature: AdminFeatureKey } | SiteCondition;

const SITE_CONDITIONS: Record<
  SiteCondition,
  (ctx: AdminSurfaceContext) => boolean
> = {
  builder: (ctx) => ctx.builder,
  // Staff open a door from its listing or group page. The doors list is a
  // scanner login's whole job, so only that role sees it in the nav.
  scanner: (ctx) => ctx.adminLevel === "scanner",
  storage: (ctx) => ctx.storage,
  support: (ctx) => ctx.support,
};

type NavRow = Omit<AdminNavEntry, "visible"> & {
  readonly visible?: NavCondition;
};

type SectionRow = Omit<AdminSectionDef, "nav" | "visible"> & {
  readonly nav: readonly NavRow[];
  readonly visible?: NavCondition;
};

/* jscpd:ignore-start -- a list of strings, not code */
const SECTION_ROWS: readonly SectionRow[] = [
  {
    id: "home",
    labelKey: "nav.public.home",
    landing: "home",
    nav: [{ id: "home", kind: "landing", labelKey: "nav.public.home" }],
  },
  {
    id: "doors",
    labelKey: "nav.doors",
    landing: "doors",
    nav: [{ id: "doors", kind: "landing", labelKey: "nav.doors" }],
    visible: "scanner",
  },
  {
    detail: "listing",
    id: "listings",
    labelKey: "terms.listings",
    landing: "listings",
    nav: [
      { id: "listings", kind: "landing", labelKey: "terms.listings" },
      { id: "listingNew", kind: "create", labelKey: "nav.sub.add" },
      { id: "catalogImport", kind: "import", labelKey: "nav.sub.import" },
    ],
  },
  {
    id: "calendar",
    labelKey: "nav.calendar",
    landing: "calendar",
    // The run sheet is an agent's only page, so agents sign in to it instead
    // of the dashboard.
    landingFor: { agent: "deliveries" },
    nav: [
      { id: "calendar", kind: "landing", labelKey: "nav.calendar" },
      {
        id: "deliveries",
        kind: "link",
        labelKey: "nav.deliveries",
        visible: { feature: "logistics" },
      },
    ],
  },
  {
    id: "servicing",
    labelKey: "nav.servicing",
    landing: "servicing",
    nav: [
      { id: "servicing", kind: "landing", labelKey: "nav.servicing" },
      { id: "servicingNew", kind: "create", labelKey: "nav.sub.add" },
    ],
    visible: { feature: "servicing" },
  },
  {
    id: "attendees",
    labelKey: "terms.attendees",
    landing: "attendees",
    nav: [
      { id: "attendees", kind: "landing", labelKey: "terms.attendees" },
      { id: "attendeeNew", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    id: "invoices",
    labelKey: "nav.invoices",
    landing: "invoices",
    nav: [{ id: "invoices", kind: "landing", labelKey: "nav.invoices" }],
    visible: { feature: "invoices" },
  },
  {
    id: "subscriptions",
    labelKey: "nav.subscriptions",
    landing: "subscriptions",
    nav: [
      { id: "subscriptions", kind: "landing", labelKey: "nav.subscriptions" },
    ],
    visible: { feature: "subscriptions" },
  },
  {
    id: "users",
    labelKey: "terms.users",
    landing: "users",
    nav: [
      { id: "users", kind: "landing", labelKey: "terms.users" },
      { id: "userNew", kind: "create", labelKey: "nav.sub.invite" },
      { id: "sessions", kind: "link", labelKey: "nav.sub.sessions" },
      {
        id: "apiKeys",
        kind: "link",
        labelKey: "nav.sub.api_keys",
        visible: { feature: "apiKeys" },
      },
    ],
  },
  {
    detail: "group",
    id: "groups",
    labelKey: "terms.groups",
    landing: "groups",
    nav: [
      { id: "groups", kind: "landing", labelKey: "terms.groups" },
      { id: "groupNew", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    id: "images",
    labelKey: "terms.images",
    landing: "images",
    nav: [
      { id: "images", kind: "landing", labelKey: "terms.images" },
      { id: "imageNew", kind: "create", labelKey: "nav.sub.add" },
    ],
    visible: "storage",
  },
  {
    id: "modifiers",
    labelKey: "terms.modifiers",
    landing: "modifiers",
    nav: [
      { id: "modifiers", kind: "landing", labelKey: "terms.modifiers" },
      { id: "modifierNew", kind: "create", labelKey: "nav.sub.add" },
    ],
    visible: { feature: "modifiers" },
  },
  {
    id: "ledger",
    labelKey: "nav.ledger",
    landing: "ledger",
    nav: [{ id: "ledger", kind: "landing", labelKey: "nav.ledger" }],
    visible: { feature: "money" },
  },
  {
    id: "site",
    labelKey: "nav.site",
    landing: "site",
    nav: [
      { id: "site", kind: "landing", labelKey: "site.sub_nav.homepage" },
      { id: "siteContact", kind: "link", labelKey: "site.sub_nav.contact" },
      { id: "siteOrder", kind: "link", labelKey: "site.sub_nav.order" },
      { id: "sitePages", kind: "link", labelKey: "nav.site.pages" },
      { id: "news", kind: "link", labelKey: "nav.site.news" },
    ],
    visible: { feature: "site" },
  },
  {
    detail: "builtSite",
    id: "builtSites",
    labelKey: "nav.built_sites",
    landing: "builtSites",
    nav: [{ id: "builtSites", kind: "landing", labelKey: "nav.built_sites" }],
    visible: "builder",
  },
  {
    id: "settings",
    labelKey: "nav.settings",
    landing: "settings",
    nav: [
      { id: "settings", kind: "landing", labelKey: "nav.sub.settings" },
      {
        id: "listingDefaults",
        kind: "link",
        labelKey: "nav.sub.listing_defaults",
      },
      { id: "statuses", kind: "link", labelKey: "nav.sub.statuses" },
      { id: "privacy", kind: "link", labelKey: "nav.sub.privacy" },
      {
        id: "attributes",
        kind: "link",
        labelKey: "terms.attributes",
        visible: { feature: "attributes" },
      },
      {
        id: "questions",
        kind: "link",
        labelKey: "terms.questions",
        visible: { feature: "questions" },
      },
      {
        id: "externalSources",
        kind: "link",
        labelKey: "nav.sub.external_sources",
        visible: { feature: "externalSources" },
      },
      {
        id: "logistics",
        kind: "link",
        labelKey: "nav.logistics",
        visible: { feature: "logistics" },
      },
      { id: "emails", kind: "link", labelKey: "nav.emails" },
      { id: "holidays", kind: "link", labelKey: "terms.holidays" },
      { id: "settingsAdvanced", kind: "link", labelKey: "nav.sub.advanced" },
      { id: "backup", kind: "link", labelKey: "nav.sub.backups" },
      { id: "debug", kind: "link", labelKey: "nav.sub.debug" },
      { id: "schemaAtlas", kind: "link", labelKey: "nav.sub.schema" },
    ],
  },
  {
    id: "guide",
    labelKey: "nav.guide",
    landing: "guide",
    nav: [
      { id: "guide", kind: "landing", labelKey: "nav.guide" },
      {
        id: "support",
        kind: "link",
        labelKey: "nav.support",
        visible: "support",
      },
    ],
  },
];
/* jscpd:ignore-end */

const conditionCheck = (
  condition: NavCondition,
): ((ctx: AdminSurfaceContext) => boolean) =>
  typeof condition === "string"
    ? SITE_CONDITIONS[condition]
    : featureVisible(condition.feature);

/** Turn a row's condition into the check the nav runs for each viewer. */
const withCheck = <Row extends { readonly visible?: NavCondition }>(
  row: Row,
): Omit<Row, "visible"> & {
  readonly visible?: (ctx: AdminSurfaceContext) => boolean;
} => {
  const { visible, ...rest } = row;
  if (visible === undefined) return rest;
  return { ...rest, visible: conditionCheck(visible) };
};

const sectionDef = (row: SectionRow): AdminSectionDef => ({
  ...withCheck(row),
  nav: row.nav.map(withCheck),
});

export const ADMIN_SECTIONS: readonly AdminSectionDef[] =
  SECTION_ROWS.map(sectionDef);
