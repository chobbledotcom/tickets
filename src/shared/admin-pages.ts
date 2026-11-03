import type {
  AdminDestinationDef,
  AdminSurfaceContext,
} from "#shared/admin-surface/definitions.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import type { AdminSectionDef } from "#shared/admin-surface/sections.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminDestinationAllowed,
  adminPath,
  oneRecordPath,
} from "#shared/admin-surface.ts";
import { normalizePath } from "#shared/path.ts";
import type { AdminLevel } from "#types";

export interface NavLink {
  readonly href: string;
  readonly labelKey: string;
}

export interface NavSection {
  readonly items: readonly NavLink[];
  readonly labelKey: string;
  readonly topHref: string;
}

const landingPattern = (section: AdminSectionDef): string =>
  adminDestination(section.landing).pattern;

/** Whether one nav link is a link this viewer can follow. The destination
 * must admit the viewer, and any bespoke gate must agree. */
const linkVisible = (
  id: AdminDestinationId,
  ctx: AdminSurfaceContext,
  visible: AdminSectionDef["visible"],
): boolean =>
  adminDestinationAllowed(id, ctx.adminLevel, ctx.isReadOnly) &&
  (visible === undefined || visible(ctx));

const visibleAdminSections = (
  ctx: AdminSurfaceContext,
): readonly AdminSectionDef[] =>
  ADMIN_SURFACE.sections.filter((section) =>
    linkVisible(section.landing, ctx, section.visible),
  );

export const visibleTopLevel = (ctx: AdminSurfaceContext): NavLink[] =>
  visibleAdminSections(ctx).map((section) => ({
    href: landingPattern(section),
    labelKey: section.labelKey,
  }));

export const visibleSections = (ctx: AdminSurfaceContext): NavSection[] =>
  visibleAdminSections(ctx)
    // A section with one link needs no sub-navigation of its own.
    .filter((section) => section.nav.length > 1)
    .map((section) => ({
      items: section.nav
        .filter((entry) => linkVisible(entry.id, ctx, entry.visible))
        .map((entry) => ({
          href: adminDestination(entry.id).pattern,
          labelKey: entry.labelKey,
        })),
      labelKey: section.labelKey,
      topHref: landingPattern(section),
    }));

/** The first section whose landing matches, when one exists. */
const sectionWhere = (
  keep: (section: AdminSectionDef) => boolean,
): AdminSectionDef | undefined => ADMIN_SURFACE.sections.find(keep);

/** Where a role lands after signing in: the page its section names, or the
 * first section whose landing route admits the role. The declaration writes
 * the dashboard as "/admin/". The app addresses it as "/admin". */
export const adminLandingPath = (adminLevel: AdminLevel): string => {
  const section = sectionWhere(
    (candidate) =>
      candidate.landingFor?.[adminLevel] !== undefined ||
      adminDestination(candidate.landing).audience.includes(adminLevel),
  );
  if (!section) {
    throw new Error(`No admin landing is declared for "${adminLevel}"`);
  }
  return normalizePath(
    adminDestination(section.landingFor?.[adminLevel] ?? section.landing)
      .pattern,
  );
};

/** Where a reader lands after acting on one of a section's records. Pass the
 * id of the route the section lands on. The reader lands on the record's own
 * page, or on that route when the record has no page. The page opens on the
 * first tab its viewer can see, so every role that reaches this has somewhere
 * to land. */
export const entityReturnPath = (
  landing: AdminDestinationId,
  id: number,
): string => {
  const section = sectionWhere((candidate) => candidate.landing === landing);
  return section?.detail === undefined
    ? adminDestination(landing).pattern
    : adminPath(section.detail, { id });
};

/** Where a save served at a route lands. Ask by the route's id, or pass the
 * route the caller already holds. The route's declaration names the landing.
 * A landing addressed by a record takes that record's id. A list landing names
 * no record and takes none. */
export const afterSavePath = (
  route: AdminDestinationId | AdminDestinationDef,
  record?: number,
): string => {
  const own = typeof route === "string" ? adminDestination(route) : route;
  const landing = own.afterSave;
  if (landing === undefined) {
    throw new Error(`Admin route "${own.id}" declares no after-save landing`);
  }
  if (!landing.pattern.includes(":")) return landing.pattern;
  if (record === undefined) {
    throw new Error(
      `Admin route "${own.id}" lands on "${landing.id}", which names a record`,
    );
  }
  return oneRecordPath(landing.pattern, record);
};

/** The patterns of the routes that match one predicate, in declaration order. */
const routePatterns = (
  keep: (route: AdminDestinationDef) => boolean,
): readonly string[] =>
  Object.values(ADMIN_SURFACE.destinations)
    .filter(keep)
    .map((route) => route.pattern);

/** The admin writes read-only mode keeps open. In update mode it keeps only
 * the ones declared `"always"`, because the migration must see a still
 * database. */
export const readOnlyWriteRoutePatterns = (
  updating: boolean,
): readonly string[] =>
  routePatterns(
    (route) =>
      route.readOnlyWrite !== undefined &&
      (!updating || route.readOnlyWrite === "always"),
  );

/** A write whose declaration carries `readOnlyGet` serves a page on its GET
 * (the built-site support message), so read-only mode keeps serving it instead
 * of redirecting it. A write declared `readOnlyWrite` keeps its GET through
 * the same declaration. */
export const readOnlyGetRoutePatterns = (): readonly string[] =>
  routePatterns(
    (route) =>
      route.intent === "write-form" &&
      route.readOnlyGet !== true &&
      route.readOnlyWrite === undefined,
  );
