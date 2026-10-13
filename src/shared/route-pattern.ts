export type RouteParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | RouteParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

const isNumericRouteParam = (name: string): boolean =>
  name.endsWith("Id") || name === "id";

/** The segment shape a public `:slug` route serves: lowercase letters and
 *  numbers with `-`, `_`, or `+` separators. One rule for the router and
 *  every caller that names a public slug URL. */
export const SLUG_PARAM_PATTERN = "[a-z0-9]+(?:[-_+][a-z0-9]+)*";

const SLUG_PARAM_SERVES = new RegExp(`^(?:${SLUG_PARAM_PATTERN})$`);

/** Whether a public route serves this slug: the route's own `:slug` pattern
 *  decides, so a slug it rejects never reaches a caller that names URLs. */
export const routeServesSlug = (slug: string): boolean =>
  SLUG_PARAM_SERVES.test(slug);

const routeParamPattern = (name: string): string => {
  if (isNumericRouteParam(name)) return "\\d+";
  if (name === "slug") return SLUG_PARAM_PATTERN;
  return "[^/]+";
};

export const compileRoutePathPattern = (
  pattern: string,
): { regex: RegExp; paramNames: string[]; numericParams: Set<string> } => {
  const paramNames: string[] = [];
  const numericParams = new Set<string>();
  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, name: string) => {
      paramNames.push(name);
      if (isNumericRouteParam(name)) numericParams.add(name);
      return `(${routeParamPattern(name)})`;
    });
  return { numericParams, paramNames, regex: new RegExp(`^${regex}$`) };
};

export const routePathPatternToRegex = (pattern: string): RegExp =>
  compileRoutePathPattern(pattern).regex;
