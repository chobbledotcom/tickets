import {
  ADMIN_API_RESOURCES,
  type AdminApiResourceName,
} from "#shared/admin-api-resources.ts";

/** The resources the CLI's generic `api` command serves, in the order the
 *  usage line and the unknown-resource error name them. `satisfies` holds the
 *  list to the table: a resource the server does not declare cannot enter. */
export const resources = [
  "attributes",
  "listings",
  "groups",
  "holidays",
] as const satisfies readonly AdminApiResourceName[];

export const parseResource = (raw: string): AdminApiResourceName => {
  if (resources.includes(raw as AdminApiResourceName)) {
    return raw as AdminApiResourceName;
  }
  throw new Error(`Unknown resource: ${raw}. Expected ${resources.join(", ")}`);
};

export const resourcePath = (
  resource: AdminApiResourceName,
  id?: string,
): string =>
  id === undefined
    ? `/api/admin/${ADMIN_API_RESOURCES[resource].path}`
    : `/api/admin/${ADMIN_API_RESOURCES[resource].path}/${id.replace(/^\/+|\/+$/g, "")}`;
