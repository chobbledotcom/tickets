import type {
  AdminSectionId,
  AdminSurfaceContext,
} from "#shared/admin-surface/definitions.ts";
import {
  ADMIN_SURFACE,
  type AdminDestinationId,
  adminDestination,
} from "#shared/admin-surface.ts";
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

const landingPattern = (
  section: Pick<(typeof ADMIN_SURFACE.sections)[number], "landing">,
): string => adminDestination(section.landing as AdminDestinationId).pattern;

const navRoutesFor = (section: AdminSectionId) =>
  ADMIN_SURFACE.destinations.filter(
    (route) => route.section === section && route.nav !== undefined,
  );

const sectionVisible = (
  section: (typeof ADMIN_SURFACE.sections)[number],
  ctx: AdminSurfaceContext,
): boolean => {
  const landing = adminDestination(section.landing as AdminDestinationId);
  return (
    landing.audience.includes(ctx.adminLevel) &&
    (!("visible" in section) || section.visible(ctx))
  );
};

const routeVisible = (
  route: (typeof ADMIN_SURFACE.destinations)[number],
  ctx: AdminSurfaceContext,
): boolean =>
  route.nav !== undefined &&
  route.audience.includes(ctx.adminLevel) &&
  !(ctx.isReadOnly && route.intent === "write-form") &&
  (!("visible" in route.nav) || route.nav.visible(ctx));

const visibleAdminSections = (ctx: AdminSurfaceContext) =>
  ADMIN_SURFACE.sections.filter((section) => sectionVisible(section, ctx));

export const visibleTopLevel = (ctx: AdminSurfaceContext): NavLink[] =>
  visibleAdminSections(ctx).map((section) => ({
    href: landingPattern(section),
    labelKey: section.labelKey,
  }));

export const visibleSections = (ctx: AdminSurfaceContext): NavSection[] =>
  visibleAdminSections(ctx)
    .map((section) => ({ routes: navRoutesFor(section.id), section }))
    .filter(({ routes }) => routes.length > 1)
    .map(({ routes, section }) => ({
      items: routes
        .filter((route) => routeVisible(route, ctx))
        .map((route) => ({
          href: route.pattern,
          // navRoutesFor keeps only destinations with navigation metadata.
          labelKey: route.nav!.labelKey,
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
  if (!section || !("detailPath" in section)) return sectionPath;
  const detail = section.detailPath.replace(":id", String(id));
  return section.staffOnlyDetail && adminLevel === "editor"
    ? `${detail}/edit`
    : detail;
};

export const readOnlyGetRoutePatterns = (): readonly string[] =>
  ADMIN_SURFACE.destinations
    .filter((route) => route.intent === "write-form")
    .map((route) => route.pattern);
