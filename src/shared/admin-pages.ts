import type {
  AdminSectionId,
  AdminSurfaceContext,
} from "#shared/admin-surface/definitions.ts";
import {
  ADMIN_SURFACE,
  type AdminRouteId,
  adminRoute,
} from "#shared/admin-surface.ts";
import type { AdminLevel } from "#shared/types.ts";

export type NavCtx = AdminSurfaceContext;

export interface NavLink {
  readonly href: string;
  readonly labelKey: string;
}

export interface NavSection {
  readonly items: readonly NavLink[];
  readonly labelKey: string;
  readonly topHref: string;
}

const sectionById = (id: AdminSectionId) =>
  ADMIN_SURFACE.sections.find((section) => section.id === id)!;

const navRoutesFor = (section: AdminSectionId) =>
  ADMIN_SURFACE.routes.filter(
    (route) => route.section === section && route.nav !== undefined,
  );

const sectionVisible = (
  section: (typeof ADMIN_SURFACE.sections)[number],
  ctx: NavCtx,
): boolean => {
  const landing = adminRoute(section.landing as AdminRouteId);
  return (
    landing.audience.includes(ctx.adminLevel) &&
    (!("visible" in section) || section.visible(ctx))
  );
};

const routeVisible = (
  route: (typeof ADMIN_SURFACE.routes)[number],
  ctx: NavCtx,
): boolean =>
  route.nav !== undefined &&
  route.audience.includes(ctx.adminLevel) &&
  !(ctx.isReadOnly && route.intent === "write-form") &&
  (!("visible" in route.nav) || route.nav.visible(ctx));

export const visibleTopLevel = (ctx: NavCtx): NavLink[] =>
  ADMIN_SURFACE.sections
    .filter((section) => sectionVisible(section, ctx))
    .map((section) => ({
      href: adminRoute(section.landing as AdminRouteId).pattern,
      labelKey: section.labelKey,
    }));

export const visibleSections = (ctx: NavCtx): NavSection[] =>
  ADMIN_SURFACE.sections
    .filter(
      (section) =>
        sectionVisible(section, ctx) && navRoutesFor(section.id).length > 1,
    )
    .map((section) => ({
      items: navRoutesFor(section.id)
        .filter((route) => routeVisible(route, ctx))
        .map((route) => ({
          href: route.pattern,
          labelKey: route.nav!.labelKey,
        })),
      labelKey: section.labelKey,
      topHref: adminRoute(section.landing as AdminRouteId).pattern,
    }));

export interface CreateLinkSection {
  readonly createHref: string;
  readonly createLabelKey: string;
  readonly featureGated: boolean;
  readonly roles: readonly AdminLevel[];
  readonly sectionPath: string;
}

export const createLinkSections = (): CreateLinkSection[] =>
  ADMIN_SURFACE.routes
    .filter((route) => route.nav?.kind === "create")
    .map((route) => {
      const section = sectionById(route.section!);
      return {
        createHref: route.pattern,
        createLabelKey: route.nav!.labelKey,
        featureGated: "visible" in section,
        roles: route.audience,
        sectionPath: adminRoute(section.landing as AdminRouteId).pattern,
      };
    });

export const entityReturnPath = (
  sectionPath: string,
  adminLevel: AdminLevel,
  id: number,
): string => {
  const section = ADMIN_SURFACE.sections.find(
    (candidate) =>
      adminRoute(candidate.landing as AdminRouteId).pattern === sectionPath,
  );
  if (!section || !("detailPath" in section)) return sectionPath;
  const detail = section.detailPath.replace(":id", String(id));
  return section.staffOnlyDetail && adminLevel === "editor"
    ? `${detail}/edit`
    : detail;
};

export const readOnlyGetRoutePatterns = (): readonly string[] =>
  ADMIN_SURFACE.routes
    .filter((route) => route.intent === "write-form")
    .map((route) => route.pattern);
