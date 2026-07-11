export type RouteParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | RouteParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

export const isNumericRouteParam = (name: string): boolean =>
  name.endsWith("Id") || name === "id";

export const routeParamPattern = (name: string): string => {
  if (isNumericRouteParam(name)) return "\\d+";
  if (name === "slug") return "[a-z0-9]+(?:[-_+][a-z0-9]+)*";
  return "[^/]+";
};

export const routePathPatternToRegex = (pattern: string): RegExp => {
  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, name: string) => routeParamPattern(name));
  return new RegExp(`^${regex}$`);
};
