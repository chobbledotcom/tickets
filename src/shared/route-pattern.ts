export type RouteParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | RouteParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

const isNumericRouteParam = (name: string): boolean =>
  name.endsWith("Id") || name === "id";

const routeParamPattern = (name: string): string => {
  if (isNumericRouteParam(name)) return "\\d+";
  if (name === "slug") return "[a-z0-9]+(?:[-_+][a-z0-9]+)*";
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
