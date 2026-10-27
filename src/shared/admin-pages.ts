import type { AdminSurfaceContext } from "#shared/admin-surface/definitions.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import type { AdminSectionDef } from "#shared/admin-surface/sections.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminDestinationAllowed,
  adminPath,
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

/** Where a role lands after signing in: the page its section names, or the
 * first section whose landing route admits the role. The declaration writes
 * the dashboard as "/admin/". The app addresses it as "/admin". */
export const adminLandingPath = (adminLevel: AdminLevel): string => {
  const section = ADMIN_SURFACE.sections.find(
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

/** Where a reader lands after acting on one of a section's records. It lands
 * on the record's own page, or on the section's list when the record has no
 * page. The page opens on the first tab its viewer can see, so every role that
 * reaches this has somewhere to land. */
export const entityReturnPath = (sectionPath: string, id: number): string => {
  const section = ADMIN_SURFACE.sections.find(
    (candidate) => landingPattern(candidate) === sectionPath,
  );
  return section?.detail ? adminPath(section.detail, { id }) : sectionPath;
};

/** The write routes whose GET is not a write form. The built-site
 * support-message tab renders the stored message for a read-only viewer, so
 * read-only mode must keep serving its GET instead of redirecting it. */
const READ_ONLY_SAFE_WRITE_PATTERNS: Record<string, true> = {
  "/admin/built-sites/:id/support-message": true,
};

export const readOnlyGetRoutePatterns = (): readonly string[] =>
  Object.values(ADMIN_SURFACE.destinations)
    .filter(
      (route) =>
        route.intent === "write-form" &&
        !(route.pattern in READ_ONLY_SAFE_WRITE_PATTERNS),
    )
    .map((route) => route.pattern);
