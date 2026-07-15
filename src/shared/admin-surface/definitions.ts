import type { EnabledFeatures } from "#shared/admin-features.ts";
import type { AdminLevel } from "#shared/types.ts";

export interface AdminSurfaceContext {
  readonly active: string;
  readonly adminLevel: AdminLevel;
  readonly builder: boolean;
  readonly enabledFeatures: EnabledFeatures;
  readonly isReadOnly: boolean;
  readonly storage: boolean;
  readonly support: boolean;
}

export const ADMIN_SURFACE_AREAS = {
  apiKeys: ["api-keys"],
  attendeeNotes: ["attendee"],
  attendeeRefunds: ["attendees", "listing"],
  attendees: ["attendees", "listing"],
  attributes: ["attributes", "listing"],
  auth: ["login", "logout"],
  backup: ["backup"],
  builder: ["builder"],
  builtSites: ["built-sites"],
  bulkActions: ["groups"],
  bulkEmail: ["emails"],
  calendar: ["calendar"],
  catalogTransfer: ["catalog", "groups", "listing"],
  contactHistory: ["history"],
  dashboard: ["", "listings", "log"],
  debug: ["debug"],
  deliveries: ["deliveries"],
  groups: ["groups"],
  guide: ["formatting", "guide"],
  holidays: ["holidays"],
  images: ["images"],
  ledger: ["ledger"],
  listingQr: ["listing"],
  listings: ["listing", "listings"],
  markdownPreview: ["markdown-preview"],
  modifiers: ["modifiers"],
  news: ["site"],
  privacy: ["privacy"],
  questions: ["listing", "questions"],
  scanner: ["listing"],
  seeds: ["seeds"],
  servicing: ["servicing"],
  sessions: ["sessions"],
  settings: ["features", "listing-defaults", "settings", "settings-advanced"],
  settingsLogistics: ["logistics"],
  settingsStatuses: ["settings"],
  site: ["site"],
  sitePages: ["site"],
  sms: ["sms"],
  support: ["support"],
  update: ["update"],
  users: ["user", "users"],
} as const;

export type AdminAreaId = keyof typeof ADMIN_SURFACE_AREAS;
export type AdminAudience = readonly AdminLevel[];
export type AdminRouteIntent = "view" | "write-form";
export type AdminNavKind = "landing" | "link" | "create" | "import";
export type AdminMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type AdminRouteDef = {
  readonly area: AdminAreaId;
  readonly id: string;
  readonly method: AdminMethod;
  readonly pattern: string;
  readonly readOnly: "allow" | "block";
};

const defineAdminRoute =
  (allowedInReadOnly: (method: AdminMethod) => boolean) =>
  <
    Id extends string,
    Area extends AdminAreaId,
    Method extends AdminMethod,
    Pattern extends string,
  >(
    id: Id,
    area: Area,
    method: Method,
    pattern: Pattern,
  ): AdminRouteDef & {
    readonly area: Area;
    readonly id: Id;
    readonly method: Method;
    readonly pattern: Pattern;
  } => ({
    area,
    id,
    method,
    pattern,
    readOnly: allowedInReadOnly(method) ? "allow" : "block",
  });

export const route = defineAdminRoute((method) => method === "GET");
const readOnlyRoute = defineAdminRoute(() => true);
export const operation = <
  Id extends string,
  Area extends AdminAreaId,
  Pattern extends string,
>(
  id: Id,
  area: Area,
  pattern: Pattern,
) => readOnlyRoute(id, area, "POST", pattern);

export const OWNER_AUDIENCE = ["owner"] as const;

export const featureVisible =
  (feature: keyof EnabledFeatures) =>
  (ctx: AdminSurfaceContext): boolean =>
    ctx.enabledFeatures[feature];

export const ADMIN_SECTIONS = [
  { id: "home", labelKey: "nav.public.home", landing: "home" },
  {
    detailPath: "/admin/listing/:id",
    id: "listings",
    labelKey: "terms.listings",
    landing: "listings",
    staffOnlyDetail: true,
  },
  { id: "calendar", labelKey: "nav.calendar", landing: "calendar" },
  {
    id: "servicing",
    labelKey: "nav.servicing",
    landing: "servicing",
    visible: featureVisible("servicing"),
  },
  { id: "attendees", labelKey: "terms.attendees", landing: "attendees" },
  { id: "users", labelKey: "terms.users", landing: "users" },
  {
    detailPath: "/admin/groups/:id",
    id: "groups",
    labelKey: "terms.groups",
    landing: "groups",
    staffOnlyDetail: true,
  },
  {
    id: "images",
    labelKey: "terms.images",
    landing: "images",
    visible: (ctx: AdminSurfaceContext) => ctx.storage,
  },
  {
    id: "modifiers",
    labelKey: "terms.modifiers",
    landing: "modifiers",
    visible: featureVisible("modifiers"),
  },
  {
    id: "ledger",
    labelKey: "nav.ledger",
    landing: "ledger",
    visible: featureVisible("money"),
  },
  {
    id: "site",
    labelKey: "nav.site",
    landing: "site",
    visible: featureVisible("site"),
  },
  { id: "settings", labelKey: "nav.settings", landing: "settings" },
] as const;

export type AdminSectionId = (typeof ADMIN_SECTIONS)[number]["id"];

export type AdminDestinationDef = {
  readonly area: AdminAreaId;
  readonly audience: AdminAudience;
  readonly id: string;
  readonly intent: AdminRouteIntent;
  readonly nav?: {
    readonly kind: AdminNavKind;
    readonly labelKey: string;
    readonly visible?: (ctx: AdminSurfaceContext) => boolean;
  };
  readonly pattern: string;
  readonly section: AdminSectionId;
};

const defineDestination =
  (intent: AdminRouteIntent) =>
  <Id extends string, Pattern extends string>(
    id: Id,
    area: AdminAreaId,
    pattern: Pattern,
    audience: AdminAudience,
    section: AdminSectionId,
    nav?: AdminDestinationDef["nav"],
  ): AdminDestinationDef & { readonly id: Id; readonly pattern: Pattern } => ({
    area,
    audience,
    id,
    intent,
    pattern,
    section,
    ...(nav ? { nav } : {}),
  });

export const view = <Id extends string, Pattern extends string>(
  id: Id,
  area: AdminAreaId,
  section: AdminSectionId,
  pattern: Pattern,
  audience: AdminAudience,
  labelKey: string,
  kind: AdminNavKind = "link",
  visible?: (ctx: AdminSurfaceContext) => boolean,
): AdminDestinationDef & { readonly id: Id; readonly pattern: Pattern } =>
  defineDestination(
    kind === "create" || kind === "import" ? "write-form" : "view",
  )(id, area, pattern, audience, section, {
    kind,
    labelKey,
    ...(visible ? { visible } : {}),
  });

export const writeForm = defineDestination("write-form");
