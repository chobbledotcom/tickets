/**
 * The shape of the admin surface declaration, and the fold that turns it into
 * the flat destination and segment maps every consumer reads.
 *
 * One area declares its own routes once. Its audience is the area default, so
 * a route only names a role when it differs from the rest of its area. The
 * segments an area serves derive from the patterns it declares; `segments`
 * lists only the extra ones an area serves without a page of its own.
 */

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

export type AdminAudience = readonly AdminLevel[];
export type AdminRouteIntent = "view" | "write-form";
export type AdminNavKind = "landing" | "link" | "create" | "import";

export const OWNER_AUDIENCE = ["owner"] as const;

export const featureVisible =
  (feature: keyof EnabledFeatures): ((ctx: AdminSurfaceContext) => boolean) =>
  (ctx: AdminSurfaceContext): boolean =>
    ctx.enabledFeatures[feature];

/** A route: its pattern alone, or a pattern whose role differs from its area. */
export type AdminDestinationSpec =
  | string
  | { readonly audience: AdminAudience; readonly pattern: string };

type AdminRouteGroup = Readonly<Record<string, AdminDestinationSpec>>;

/** An area serving pages. Declaring a route requires declaring who reaches it. */
type AdminAreaWithRoutes = {
  readonly audience: AdminAudience;
  readonly segments?: readonly string[];
  readonly view?: AdminRouteGroup;
  readonly write?: AdminRouteGroup;
};

/** An area whose routes have no page of their own, such as a POST endpoint. */
type AdminAreaWithoutRoutes = { readonly segments: readonly string[] };

export type AdminAreaSpec = AdminAreaWithRoutes | AdminAreaWithoutRoutes;
export type AdminAreasSpec = Readonly<Record<string, AdminAreaSpec>>;

export type AdminDestinationDef = {
  readonly area: string;
  readonly audience: AdminAudience;
  readonly id: string;
  readonly intent: AdminRouteIntent;
  readonly pattern: string;
};

/** The `/admin/<segment>` part of a path, or "" for `/admin` itself. */
export const adminPathSegment = (path: string): string =>
  path.split("/")[2] ?? "";

const groupDestinations = (
  area: string,
  areaAudience: AdminAudience,
  intent: AdminRouteIntent,
  group: AdminRouteGroup | undefined,
): AdminDestinationDef[] =>
  Object.entries(group ?? {}).map(([id, spec]) => ({
    area,
    audience: typeof spec === "string" ? areaAudience : spec.audience,
    id,
    intent,
    pattern: typeof spec === "string" ? spec : spec.pattern,
  }));

export type FoldedAdminSurface = {
  readonly areas: Readonly<Record<string, readonly string[]>>;
  readonly byPattern: Readonly<Record<string, AdminDestinationDef>>;
  readonly destinations: Readonly<Record<string, AdminDestinationDef>>;
};

/**
 * Fold the declaration into the flat maps consumers read: every destination by
 * id, and every area's segments. Runs once at module load over pure data.
 */
export const foldAdminAreas = (spec: AdminAreasSpec): FoldedAdminSurface => {
  const areas: Record<string, readonly string[]> = {};
  const byPattern: Record<string, AdminDestinationDef> = {};
  const destinations: Record<string, AdminDestinationDef> = {};

  for (const [areaId, area] of Object.entries(spec)) {
    const declaredSegments = area.segments ?? [];
    if (!("audience" in area)) {
      areas[areaId] = declaredSegments;
      continue;
    }
    const areaDestinations = [
      ...groupDestinations(areaId, area.audience, "view", area.view),
      ...groupDestinations(areaId, area.audience, "write-form", area.write),
    ];
    for (const destination of areaDestinations) {
      // Two areas claiming one id would leave the loser silently unreachable,
      // and every link to it pointing at the winner.
      const claimed = destinations[destination.id];
      if (claimed) {
        throw new Error(
          `Admin route "${destination.id}" is declared by both ` +
            `"${claimed.area}" and "${destination.area}"`,
        );
      }
      // Two ids at one path would give the page two audiences, and the gate
      // looked up by path would take whichever was declared second.
      const sharing = byPattern[destination.pattern];
      if (sharing) {
        throw new Error(
          `Admin path "${destination.pattern}" is declared by both ` +
            `"${sharing.id}" and "${destination.id}"`,
        );
      }
      destinations[destination.id] = destination;
      byPattern[destination.pattern] = destination;
    }
    areas[areaId] = [
      ...new Set([
        ...areaDestinations.map((one) => adminPathSegment(one.pattern)),
        ...declaredSegments,
      ]),
    ];
  }

  return { areas, byPattern, destinations };
};
