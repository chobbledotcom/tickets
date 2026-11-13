/**
 * The admin navigation: which sections the sidebar shows, and which routes sit
 * under each one, in the order a reader sees them.
 *
 * A section names its routes by id. The route itself — its pattern and the
 * role that reaches it — is declared once in `areas.ts`. A link here can
 * never point somewhere its target refuses.
 */

import { map } from "#fp";
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

const navLink = (
  id: AdminDestinationId,
  labelKey: string,
  options: Partial<Pick<AdminNavEntry, "kind" | "visible">> = {},
): AdminNavEntry => ({ id, kind: "link", labelKey, ...options });

const navLinks = map(([id, labelKey]: readonly [AdminDestinationId, string]) =>
  navLink(id, labelKey),
);

const featureLink = (
  id: AdminDestinationId,
  labelKey: string,
  feature: AdminFeatureKey,
): AdminNavEntry => navLink(id, labelKey, { visible: featureVisible(feature) });

const section = (
  landing: AdminDestinationId,
  labelKey: string,
  more: readonly AdminNavEntry[] = [],
  {
    landingLabelKey = labelKey,
    ...options
  }: Partial<Pick<AdminSectionDef, "detail" | "landingFor" | "visible">> & {
    readonly landingLabelKey?: string;
  } = {},
): AdminSectionDef => ({
  id: landing,
  labelKey,
  landing,
  nav: [navLink(landing, landingLabelKey, { kind: "landing" }), ...more],
  ...options,
});

/** A section shown while one feature is on. */
const featureSection = (
  id: AdminDestinationId,
  labelKey: string,
  feature: AdminFeatureKey,
  more: readonly AdminNavEntry[] = [],
): AdminSectionDef =>
  section(id, labelKey, more, { visible: featureVisible(feature) });

export const ADMIN_SECTIONS: readonly AdminSectionDef[] = [
  section("home", "nav.public.home"),
  section("doors", "nav.doors", [], {
    // Staff open a door from its listing or group page. The doors list is a
    // scanner login's whole job, so only that role sees it in the nav.
    visible: (ctx) => ctx.adminLevel === "scanner",
  }),
  section(
    "listings",
    "terms.listings",
    [
      navLink("listingNew", "nav.sub.add", { kind: "create" }),
      navLink("catalogImport", "nav.sub.import", { kind: "import" }),
    ],
    { detail: "listing" },
  ),
  section(
    "calendar",
    "nav.calendar",
    [featureLink("deliveries", "nav.deliveries", "logistics")],
    {
      // The run sheet is an agent's only page, so agents sign in to it instead
      // of the dashboard.
      landingFor: { agent: "deliveries" },
    },
  ),
  featureSection("servicing", "nav.servicing", "servicing", [
    navLink("servicingNew", "nav.sub.add", { kind: "create" }),
  ]),
  section("attendees", "terms.attendees", [
    navLink("attendeeNew", "nav.sub.add", { kind: "create" }),
  ]),
  featureSection("invoices", "nav.invoices", "invoices"),
  featureSection("subscriptions", "nav.subscriptions", "subscriptions"),
  section("users", "terms.users", [
    navLink("userNew", "nav.sub.invite", { kind: "create" }),
    ...navLinks([["sessions", "nav.sub.sessions"]]),
    featureLink("apiKeys", "nav.sub.api_keys", "apiKeys"),
  ]),
  section(
    "groups",
    "terms.groups",
    [navLink("groupNew", "nav.sub.add", { kind: "create" })],
    { detail: "group" },
  ),
  section(
    "images",
    "terms.images",
    [navLink("imageNew", "nav.sub.add", { kind: "create" })],
    { visible: (ctx) => ctx.storage },
  ),
  featureSection("modifiers", "terms.modifiers", "modifiers", [
    navLink("modifierNew", "nav.sub.add", { kind: "create" }),
  ]),
  featureSection("ledger", "nav.ledger", "money"),
  section(
    "site",
    "nav.site",
    navLinks([
      ["siteContact", "site.sub_nav.contact"],
      ["siteOrder", "site.sub_nav.order"],
      ["sitePages", "nav.site.pages"],
      ["news", "nav.site.news"],
    ]),
    {
      landingLabelKey: "site.sub_nav.homepage",
      visible: featureVisible("site"),
    },
  ),
  section("builtSites", "nav.built_sites", [], {
    detail: "builtSite",
    visible: (ctx) => ctx.builder,
  }),
  section(
    "settings",
    "nav.settings",
    [
      ...navLinks([
        ["listingDefaults", "nav.sub.listing_defaults"],
        ["statuses", "nav.sub.statuses"],
        ["privacy", "nav.sub.privacy"],
      ]),
      featureLink("attributes", "terms.attributes", "attributes"),
      featureLink("questions", "terms.questions", "questions"),
      featureLink(
        "externalSources",
        "nav.sub.external_sources",
        "externalSources",
      ),
      featureLink("logistics", "nav.logistics", "logistics"),
      ...navLinks([
        ["emails", "nav.emails"],
        ["holidays", "terms.holidays"],
        ["settingsAdvanced", "nav.sub.advanced"],
        ["backup", "nav.sub.backups"],
        ["debug", "nav.sub.debug"],
        ["schemaAtlas", "nav.sub.schema"],
      ]),
    ],
    { landingLabelKey: "nav.sub.settings" },
  ),
  section("guide", "nav.guide", [
    navLink("support", "nav.support", { visible: (ctx) => ctx.support }),
  ]),
];
