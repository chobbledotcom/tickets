import type { AdminSurfaceContext } from "#shared/admin-surface/definitions.ts";
import type {
  AdminNavEntry,
  AdminSectionDef,
} from "#shared/admin-surface/sections.ts";
import { ADMIN_SURFACE, adminDestination } from "#shared/admin-surface.ts";
import type { AdminLevel } from "#shared/types.ts";

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

const sectionVisible = (
  section: AdminSectionDef,
  ctx: AdminSurfaceContext,
): boolean =>
  adminDestination(section.landing).audience.includes(ctx.adminLevel) &&
  (section.visible === undefined || section.visible(ctx));

const navEntryVisible = (
  entry: AdminNavEntry,
  ctx: AdminSurfaceContext,
): boolean => {
  const route = adminDestination(entry.id);
  return (
    route.audience.includes(ctx.adminLevel) &&
    !(ctx.isReadOnly && route.intent === "write-form") &&
    (entry.visible === undefined || entry.visible(ctx))
  );
};

const visibleAdminSections = (
  ctx: AdminSurfaceContext,
): readonly AdminSectionDef[] =>
  ADMIN_SURFACE.sections.filter((section) => sectionVisible(section, ctx));

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
        .filter((entry) => navEntryVisible(entry, ctx))
        .map((entry) => ({
          href: adminDestination(entry.id).pattern,
          labelKey: entry.labelKey,
        })),
      labelKey: section.labelKey,
      topHref: landingPattern(section),
    }));

export const entityReturnPath = (
  sectionPath: string,
  adminLevel: AdminLevel,
  id: number,
): string => {
  const section = ADMIN_SURFACE.sections.find(
    (candidate) => landingPattern(candidate) === sectionPath,
  );
  if (!section?.detailPath) return sectionPath;
  const detail = section.detailPath.replace(":id", String(id));
  return section.staffOnlyDetail && adminLevel === "editor"
    ? `${detail}/edit`
    : detail;
};

export const readOnlyGetRoutePatterns = (): readonly string[] =>
  Object.values(ADMIN_SURFACE.destinations)
    .filter((route) => route.intent === "write-form")
    .map((route) => route.pattern);
