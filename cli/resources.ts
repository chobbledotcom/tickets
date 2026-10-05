export const resources = [
  "attributes",
  "listings",
  "groups",
  "holidays",
] as const;

export type ResourceName = (typeof resources)[number];

export const parseResource = (raw: string): ResourceName => {
  if (resources.includes(raw as ResourceName)) return raw as ResourceName;
  throw new Error(`Unknown resource: ${raw}. Expected ${resources.join(", ")}`);
};

export const resourcePath = (resource: ResourceName, id?: string): string =>
  id === undefined
    ? `/api/admin/${resource}`
    : `/api/admin/${resource}/${id.replace(/^\/+|\/+$/g, "")}`;
