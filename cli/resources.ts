export const resources = ["listings", "groups", "holidays"] as const;

export type ResourceName = (typeof resources)[number];

export const resourcePath = (resource: ResourceName, id?: string): string =>
  id ? `/api/admin/${resource}/${id}` : `/api/admin/${resource}`;

export const parseResource = (raw: string): ResourceName => {
  if (resources.includes(raw as ResourceName)) return raw as ResourceName;
  throw new Error(`Unknown resource: ${raw}. Expected ${resources.join(", ")}`);
};
