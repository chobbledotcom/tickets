/**
 * Admin built site management routes - owner only
 */

import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import {
  type BuiltSiteFormInput,
  builtSitesCrudTable,
  getAllBuiltSites,
} from "#shared/db/built-sites.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
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
  assignable: values.assignable === "1",
  bunnyScriptId: String(values.bunny_script_id),
  bunnyUrl: String(values.bunny_url),
  dbToken: String(values.db_token),
  dbUrl: String(values.db_url),
  name: String(values.name),
});

/** Built sites resource for REST create/update operations */
const builtSitesResource = defineNamedResource({
  fields: builtSiteFields,
  nameField: "name",
  table: builtSitesCrudTable,
  toInput: extractBuiltSiteInput,
});

const crud = createOwnerCrudHandlers({
  getAll: getAllBuiltSites,
  getName: (s) => s.name,
  listPath: "/admin/built-sites",
  renderDelete: adminBuiltSiteDeletePage,
  renderEdit: adminBuiltSiteEditPage,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  resource: builtSitesResource,
  singular: "Built site",
});

/** Built site routes */
export const builtSitesRoutes = crud.routes;
