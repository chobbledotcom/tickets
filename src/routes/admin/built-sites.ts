/**
 * Admin built site management routes - owner only
 */

import {
  type BuiltSiteFormInput,
  builtSitesCrudTable,
  getAllBuiltSites,
} from "#lib/db/built-sites.ts";
import { defineNamedResource } from "#lib/rest/resource.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteEditPage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { builtSiteFields } from "#templates/fields.ts";

/** Extract built site input from validated form values */
const extractBuiltSiteInput = (
  values: Record<string, string | number | null>,
): BuiltSiteFormInput => ({
  name: String(values.name),
  bunnyUrl: String(values.bunny_url),
  dbUrl: String(values.db_url),
  dbToken: String(values.db_token),
  assignable: values.assignable === "1",
});

/** Built sites resource for REST create/update operations */
const builtSitesResource = defineNamedResource({
  table: builtSitesCrudTable,
  fields: builtSiteFields,
  toInput: extractBuiltSiteInput,
  nameField: "name",
});

const crud = createOwnerCrudHandlers({
  singular: "Built site",
  listPath: "/admin/built-sites",
  getAll: getAllBuiltSites,
  resource: builtSitesResource,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  renderEdit: adminBuiltSiteEditPage,
  renderDelete: adminBuiltSiteDeletePage,
  getName: (s) => s.name,
});

/** Built site routes */
export const builtSitesRoutes = crud.routes;
