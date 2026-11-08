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

// JS `$` also matches before one final newline. URL parsing drops that
// newline, so the emitted location cannot identify the stored page. The
// lookahead makes the match end at the true end of the input. A public route
// serves a slug only when it matches this pattern. A slug it rejects never
// reaches a caller that names URLs.
export const SLUG_PARAM_SERVES = new RegExp(
  `^(?:${SLUG_PARAM_PATTERN})$(?![\\s\\S])`,
);

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
