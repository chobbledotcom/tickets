/**
 * The admin navigation: which sections the sidebar shows, and which routes sit
 * under each one, in the order a reader sees them.
 *
 * A section names its routes by id. The route itself — its pattern and the
 * role that reaches it — is declared once in `areas.ts`, so a link here can
 * never point somewhere its target refuses.
 */

import {
  type AdminNavKind,
  type AdminSurfaceContext,
  featureVisible,
} from "#shared/admin-surface/definitions.ts";
import type {
  AdminDestinationId,
  AdminRecordDestinationId,
} from "#shared/admin-surface/ids.ts";

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
  readonly nav: readonly AdminNavEntry[];
  readonly visible?: (ctx: AdminSurfaceContext) => boolean;
};

export const ADMIN_SECTIONS: readonly AdminSectionDef[] = [
  {
    id: "home",
    labelKey: "nav.public.home",
    landing: "home",
    nav: [{ id: "home", kind: "landing", labelKey: "nav.public.home" }],
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
    nav: [
      { id: "calendar", kind: "landing", labelKey: "nav.calendar" },
      {
        id: "deliveries",
        kind: "link",
        labelKey: "nav.deliveries",
        visible: featureVisible("logistics"),
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
    visible: featureVisible("servicing"),
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
        visible: featureVisible("apiKeys"),
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
    visible: (ctx) => ctx.storage,
  },
  {
    id: "modifiers",
    labelKey: "terms.modifiers",
    landing: "modifiers",
    nav: [
      { id: "modifiers", kind: "landing", labelKey: "terms.modifiers" },
      { id: "modifierNew", kind: "create", labelKey: "nav.sub.add" },
    ],
    visible: featureVisible("modifiers"),
  },
  {
    id: "ledger",
    labelKey: "nav.ledger",
    landing: "ledger",
    nav: [{ id: "ledger", kind: "landing", labelKey: "nav.ledger" }],
    visible: featureVisible("money"),
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
    visible: featureVisible("site"),
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
        visible: featureVisible("attributes"),
      },
      {
        id: "questions",
        kind: "link",
        labelKey: "terms.questions",
        visible: featureVisible("questions"),
      },
      {
        id: "logistics",
        kind: "link",
        labelKey: "nav.logistics",
        visible: featureVisible("logistics"),
      },
      { id: "emails", kind: "link", labelKey: "nav.emails" },
      { id: "holidays", kind: "link", labelKey: "terms.holidays" },
      {
        id: "builtSites",
        kind: "link",
        labelKey: "nav.built_sites",
        visible: (ctx) => ctx.builder,
      },
      { id: "settingsAdvanced", kind: "link", labelKey: "nav.sub.advanced" },
      { id: "backup", kind: "link", labelKey: "nav.sub.backups" },
      { id: "update", kind: "link", labelKey: "nav.sub.updates" },
      { id: "debug", kind: "link", labelKey: "nav.sub.debug" },
      { id: "schemaAtlas", kind: "link", labelKey: "nav.sub.schema" },
      {
        id: "support",
        kind: "link",
        labelKey: "nav.support",
        visible: (ctx) => ctx.support,
      },
    ],
  },
];
