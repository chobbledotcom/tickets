/**
 * The shape of the admin surface declaration, and the fold that turns it into
 * the flat destination and segment maps every consumer reads.
 *
 * One area declares its own routes once. Its audience is the area default, so
 * a route only names a role when it differs from the rest of its area. The
 * segments an area serves derive from the patterns it declares. `segments`
 * lists only the extra ones an area serves without a page of its own.
 */

import type { EnabledFeatures } from "#shared/admin-features.ts";
import type { AdminLevel } from "#types";

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

/** A route: its pattern alone, or an object that differs from its area. The
 * object names a role of its own, a GET read-only mode keeps serving, the
 * page a save lands on, or any of these. */
export type AdminDestinationSpec =
  | string
  | {
      /** The id of the page a save served at this route lands on, when that
       * page is not this route's own. A save that returns to its own form
       * needs no declaration. */
      readonly afterSave?: string;
      readonly audience?: AdminAudience;
      readonly pattern: string;
      readonly readOnlyGet?: true;
    };

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
  /** The page a save served at this route lands on, when it is not this
   * route's own page. */
  readonly afterSave?: AdminDestinationDef;
  readonly area: string;
  readonly audience: AdminAudience;
  readonly id: string;
  /** The GET this write route serves is not a form: read-only mode keeps
   * serving it instead of redirecting it. */
  readonly readOnlyGet?: true;
  readonly intent: AdminRouteIntent;
  readonly pattern: string;
};

/** The `/admin/<segment>` part of a path, or "" for `/admin` itself. */
export const adminPathSegment = (path: string): string =>
  path.split("/")[2] ?? "";

/** What the fold builds for a route. The landing it names stays an id until
 * every route is known. The route it resolves to is filled in after. */
type DeclaredDestination = Omit<AdminDestinationDef, "afterSave"> & {
  afterSave?: AdminDestinationDef;
  readonly afterSaveId?: string;
};

const groupDestinations = (
  area: string,
  areaAudience: AdminAudience,
  intent: AdminRouteIntent,
  group: AdminRouteGroup | undefined,
): DeclaredDestination[] =>
  Object.entries(group ?? {}).map(([id, spec]) => {
    // The string form is the bare pattern; the object form names the rest.
    const object = typeof spec === "string" ? { pattern: spec } : spec;
    return {
      area,
      audience: object.audience ?? areaAudience,
      id,
      ...(object.afterSave === undefined
        ? {}
        : { afterSaveId: object.afterSave }),
      ...(object.readOnlyGet === true ? { readOnlyGet: true } : {}),
      intent,
      pattern: object.pattern,
    };
  });

/** Name each declared landing route, now that every route is known. A landing
 * that names nothing is a typo. The reader meets it as a redirect to a path
 * no page serves. The fold refuses it here instead. It also refuses a route
 * that names itself. A saved record fills one parameter, so it refuses a
 * landing that names two. */
const resolveAfterSave = (
  declared: ReadonlyMap<string, DeclaredDestination>,
): Record<string, AdminDestinationDef> => {
  const built: Record<string, DeclaredDestination> = {};
  for (const [id, { afterSaveId: _landing, ...destination }] of declared) {
    built[id] = destination;
  }
  for (const [id, destination] of Object.entries(built)) {
    const afterSaveId = declared.get(id)?.afterSaveId;
    if (afterSaveId === undefined) continue;
    const landing = built[afterSaveId];
    if (landing === undefined) {
      throw new Error(
        `Admin route "${id}" saves to "${afterSaveId}", which no route declares`,
      );
    }
    // A save that returns to its own form names no landing. A route that
    // names itself holds itself, and every reader of the landing then walks
    // a loop.
    if (afterSaveId === id) {
      throw new Error(
        `Admin route "${id}" saves to itself. A save that returns to its own ` +
          "form needs no afterSave",
      );
    }
    // One saved record fills one parameter. A landing that names two takes
    // the same id twice, and that path serves no page.
    if ((landing.pattern.match(/:\w+/g) ?? []).length > 1) {
      throw new Error(
        `Admin route "${id}" saves to "${afterSaveId}", which names more ` +
          "than one record",
      );
    }
    destination.afterSave = landing;
  }
  return built;
};

export type FoldedAdminSurface = {
  readonly areas: Readonly<Record<string, readonly string[]>>;
  readonly byPattern: Readonly<Record<string, AdminDestinationDef>>;
  readonly destinations: Readonly<Record<string, AdminDestinationDef>>;
};

/** Declare one area's routes and return the segments it serves, refusing an
 * id or a path another area already took. */
const declareArea = (
  areaId: string,
  area: AdminAreaWithRoutes,
  declared: Map<string, DeclaredDestination>,
  patternOf: Map<string, string>,
): readonly string[] => {
  const { segments = [] } = area;
  const areaDestinations = [
    ...groupDestinations(areaId, area.audience, "view", area.view),
    ...groupDestinations(areaId, area.audience, "write-form", area.write),
  ];
  for (const destination of areaDestinations) {
    // Two areas claiming one id would leave the loser silently unreachable,
    // and every link to it pointing at the winner.
    const claimed = declared.get(destination.id);
    if (claimed) {
      throw new Error(
        `Admin route "${destination.id}" is declared by both ` +
          `"${claimed.area}" and "${destination.area}"`,
      );
    }
    // Two ids at one path would give the page two audiences, and the gate
    // looked up by path would take whichever was declared second.
    const sharing = patternOf.get(destination.pattern);
    if (sharing) {
      throw new Error(
        `Admin path "${destination.pattern}" is declared by both ` +
          `"${sharing}" and "${destination.id}"`,
      );
    }
    declared.set(destination.id, destination);
    patternOf.set(destination.pattern, destination.id);
  }
  return [
    ...new Set([
      ...areaDestinations.map((one) => adminPathSegment(one.pattern)),
      ...segments,
    ]),
  ];
};

/**
 * Fold the declaration into the flat maps consumers read: every destination by
 * id, and every area's segments. Runs once at module load over pure data.
 */
export const foldAdminAreas = (spec: AdminAreasSpec): FoldedAdminSurface => {
  const areas: Record<string, readonly string[]> = {};
  const declared = new Map<string, DeclaredDestination>();
  const patternOf = new Map<string, string>();

  for (const [areaId, area] of Object.entries(spec)) {
    areas[areaId] =
      "audience" in area
        ? declareArea(areaId, area, declared, patternOf)
        : area.segments;
  }

  const destinations = resolveAfterSave(declared);
  const byPattern = Object.fromEntries(
    Object.values(destinations).map(
      (destination) => [destination.pattern, destination] as const,
    ),
  );
  return { areas, byPattern, destinations };
};

/** A gate's two audience spellings: one required role, or a role list. */
export type GateAudience = {
  role: AdminLevel | undefined;
  roles: readonly AdminLevel[] | undefined;
};

/** True when a refused gate admits only the owner account: either the guard
 *  names the role exactly, or it names one role and that role is owner. */
export const ownerOnlyAudience = ({ role, roles }: GateAudience): boolean =>
  role === "owner" ||
  (roles !== undefined && roles.length === 1 && roles[0] === "owner");
