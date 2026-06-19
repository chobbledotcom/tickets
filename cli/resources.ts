export type ResourceName = "listings" | "attendees" | "modifiers";

export const resources = ["listings", "attendees", "modifiers"] as const;

export const resourcePath = (resource: ResourceName, id?: string): string =>
  id ? `/api/admin/${resource}/${id}` : `/api/admin/${resource}`;

export const parseResource = (raw: string): ResourceName => {
  if (resources.includes(raw as ResourceName)) return raw as ResourceName;
  throw new Error(`Unknown resource: ${raw}. Expected ${resources.join(", ")}`);
};
