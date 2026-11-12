/**
 * Admin group management routes. The group record owns the write rule and the
 * package-member write. Each route declares its own audience in
 * `admin-surface/areas.ts`. An editor reaches the list, the record page, and
 * the create/edit routes. Only staff can delete.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { generateUniqueGroupSlug, getGroupById } from "#db/groups.ts";
import { t } from "#i18n";
import {
  handleAddListingsToGroup,
  handleRemoveListingsGet,
  handleRemoveListingsPost,
} from "#routes/admin/group-listing-forms.ts";
import {
  defineAdminRoutes,
  entityTabRoutes,
} from "#routes/admin/route-tables.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  type GroupInput,
  groupCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import {
  applyDemoOverrides,
  GROUP_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import { groupRecord, soldHiddenPackageError } from "#shared/records/groups.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { normalizeSlug } from "#shared/slug.ts";
import { adminGroupDeletePage } from "#templates/admin/groups/delete.tsx";
import { adminGroupNewPage } from "#templates/admin/groups/form.tsx";
import { adminGroupsPage } from "#templates/admin/groups/list.tsx";
import {
  type GroupCreateFormValues,
  type GroupFormValues,
  getGroupCreateForm,
  getGroupForm,
} from "#templates/fields/group.ts";
import { groupNoteFeature } from "./catalog-notes.ts";
import { withEntityLoader } from "./entity-handlers.ts";
import { groupPage } from "./group-page.ts";
import { createItemImageHandlers } from "./item-images.ts";
import {
  parsePackageMembers,
  validatePackageMemberForm,
} from "./package-member-rules.ts";
import { bindNoteRoutes } from "./record-notes.ts";

const sharedGroupFields = (values: GroupCreateFormValues) =>
  projectCatalogFields(groupCatalogFields, "form", values);

const extractGroupCreateInput = async (
  values: GroupCreateFormValues,
): Promise<GroupInput> => {
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  return { ...sharedGroupFields(values), slug, slugIndex };
};

/** The edit input carries the submitted slug and the package members read from
 * the raw form. The record's package write runs on it. */
const extractGroupEditInput = async (
  values: GroupFormValues,
  form: FormParams,
): Promise<GroupInput> => {
  const slug = normalizeSlug(values.slug);
  const fields = sharedGroupFields(values);
  return {
    ...fields,
    packageMembers: fields.isPackage ? parsePackageMembers(form) : [],
    slug,
    slugIndex: await hmacHash(slug),
  };
};

const pages = recordPages(groupRecord, {
  deleteGuard: (group) => soldHiddenPackageError(group.id),
  editForm: getGroupForm(),
  form: getGroupCreateForm(),
  identifierLabel: t("groups.name_label"),
  preprocessForm: (form) => applyDemoOverrides(form, GROUP_DEMO_FIELDS),
  renderDelete: adminGroupDeletePage,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  singular: "Group",
  toEditInput: extractGroupEditInput,
  toInput: extractGroupCreateInput,
  validateForm: validatePackageMemberForm,
});

export const withGroup = withEntityLoader((id: number) => getGroupById(id));

const groupImageHandlers = createItemImageHandlers({
  disabledPath: (id) => `/admin/groups/${id}/edit`,
  itemType: "group",
  load: (id) => getGroupById(id),
  nameOf: (group) => group.name,
  path: (id) => `/admin/groups/${id}/images`,
});

export const adminHandlers = defineAdminRoutes({
  "GET /admin/groups": pages.listGet,

  ...entityTabRoutes(adminPattern("group"), groupPage),
  ...bindNoteRoutes("/admin/groups", "id", groupNoteFeature.routes),
  "GET /admin/groups/:id/delete": pages.deleteGet,
  "GET /admin/groups/:id/remove-listings": handleRemoveListingsGet,
  "GET /admin/groups/new": pages.newGet,
  "POST /admin/groups": pages.createPost,
  "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  "POST /admin/groups/:id/delete": pages.deletePost,
  "POST /admin/groups/:id/edit": pages.editPost,
  "POST /admin/groups/:id/images": groupImageHandlers.set,
  "POST /admin/groups/:id/images/upload": groupImageHandlers.upload,
  "POST /admin/groups/:id/remove-listings": handleRemoveListingsPost,
});
