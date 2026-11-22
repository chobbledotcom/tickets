import { logActivity } from "#db/activity-log.ts";
import {
  type AttributeOption,
  type AttributeWithOptions,
  attributeOptionIdsIn,
  attributeOptionsOrder,
  attributesOrder,
  deleteAttributeOption,
  getAttributeIdsOrdered,
  getAttributeListingUse,
  getAttributeWithOptions,
  listingAttributeOptions,
} from "#db/attributes.ts";
import type { TxScope } from "#db/client.ts";
import { insertScopedOrderedRow } from "#db/ordered-collection.ts";
import { records } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { t } from "#i18n";
import {
  createVerifiedFormRoute,
  verifiedDelete,
} from "#routes/admin/confirmation.ts";
import {
  defineAdminRoutes,
  listCrudRoutes,
} from "#routes/admin/route-tables.ts";
import { formGuard, formPolicyFor, pageGuardFor } from "#routes/auth.ts";
import {
  createEntityHandler,
  entityPageById,
  orNotFound,
  throughParent,
} from "#routes/entity.ts";
import { adminRedirect, htmlResponse } from "#routes/response.ts";
import type { AdminPathParams } from "#shared/admin-surface/ids.ts";
import { adminDestinationAt, adminPattern } from "#shared/admin-surface.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { SubmittedValueProps } from "#shared/form-data.ts";
import { idRows, orderedListRoutes } from "#shared/ordered-list-routes.ts";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  adminAttributeDeletePage,
  adminAttributeOptionDeletePage,
  adminAttributeOptionEditPage,
  adminAttributePage,
  adminAttributesPage,
  attributeNameFlat,
} from "#templates/admin/attributes.tsx";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#templates/fields/attribute.ts";
import type { AdminSession } from "#types";
import {
  attributeListingRows,
  optionListingCounts,
} from "./attribute-page-data.ts";
import { createListingChoicePost } from "./listing-choice-post.ts";

const pages = recordPages(attributeRecord, {
  createErrorPath: "/admin/attributes",
  form: attributeNameForm,
  identifier: (attribute) => attributeNameFlat(attribute.name),
  renderDelete: adminAttributeDeletePage,
  renderEditError: (id, session, form, error) =>
    orNotFound(getAttributeWithOptions(id), async (attribute) =>
      htmlResponse(
        await renderAttributePage(attribute, session, {
          error,
          values: form.toRenderValues(),
        }),
        400,
      ),
    ),
  renderList: (rows, session) =>
    adminAttributesPage(rows, session, getFlash().error),
  toInput: ({ name }) => ({ name }),
});

/** The listing usage both detail pages show: which listings selected each of
 * the attribute's options. The answer holds per-option counts plus a builder
 * that turns any subset of the options into "listings using this" table
 * rows. */
const loadAttributeListingUse = async (attributeId: number) => {
  const { listingIdsByOption, listings } =
    await getAttributeListingUse(attributeId);
  return {
    listingCounts: optionListingCounts(listingIdsByOption),
    rowsFor: (options: AttributeOption[]) =>
      attributeListingRows(options, listingIdsByOption, listings),
  };
};

/** The attribute page. A refused edit passes its message and what was typed. */
const renderAttributePage = async (
  attribute: AttributeWithOptions,
  session: AdminSession,
  submitted: SubmittedValueProps = {},
): Promise<string> => {
  const { listingCounts, rowsFor } = await loadAttributeListingUse(
    attribute.id,
  );
  return adminAttributePage(
    attribute,
    session,
    submitted.error ?? getFlash().error,
    { listingCounts, listings: rowsFor(attribute.options) },
    submitted.values,
  );
};

const handleAttributeGet = entityPageById(
  "/admin/attributes/:id",
  getAttributeWithOptions,
  async (attribute, session) =>
    htmlResponse(await renderAttributePage(attribute, session)),
);

type AttributeOptionParams = { id: number; optionId: number };
type AttributeOptionContext = {
  attribute: AttributeWithOptions;
  option: AttributeOption;
};

const logAttributeOptionActivity = (
  optionText: string,
  action: string,
  attribute: AttributeWithOptions,
  transaction?: TxScope,
) =>
  logActivity(
    `Attribute option '${optionText}' ${action} ${attributeNameFlat(
      attribute.name,
    )}`,
    undefined,
    undefined,
    transaction,
  );

/** Delete one option and log it against its attribute. The one delete the
 * HTML route and the JSON API route share. */
export const deleteAttributeOptionWithLog = async (
  attribute: AttributeWithOptions,
  option: AttributeOption,
): Promise<void> => {
  await deleteAttributeOption(option.id);
  await logAttributeOptionActivity(option.text, "deleted from", attribute);
};

/** Insert an option and place it in its attribute's order, atomically. */
const addOptionRow = insertScopedOrderedRow(
  tables.attribute_options,
  attributeOptionsOrder,
);

/** Add an option to an attribute, in its order, and log it. The one add the
 * HTML route and the JSON API route share. */
export const addAttributeOptionWithLog = async (
  attribute: AttributeWithOptions,
  text: string,
): Promise<void> => {
  await addOptionRow(
    attribute.id,
    { attributeId: attribute.id, sortOrder: 0, text },
    (transaction) =>
      logAttributeOptionActivity(text, "added to", attribute, transaction),
  );
};

/** Rename an option and log it. The one rename the HTML route and the JSON
 * API route share. */
export const renameAttributeOptionWithLog = async (
  attribute: AttributeWithOptions,
  option: AttributeOption,
  text: string,
): Promise<void> => {
  await records.attribute_options.update(option.id, { text });
  await logAttributeOptionActivity(text, "updated in", attribute);
};

/** One option form's refusal, back on the page that submitted it. */
const optionFormRefusal =
  <Id extends "attribute" | "attributeOptionEdit">(destination: Id) =>
  ({ error, params }: { error: string; params: AdminPathParams<Id> }) =>
    adminRedirect(destination, params, error, false);

const handleAddOption = createAuthedFormRoute<{ text: string }, { id: number }>(
  {
    auth: formPolicyFor(adminDestinationAt("/admin/attributes/:id/options")),
    form: attributeOptionForm,
    onInvalid: optionFormRefusal("attribute"),
    onValid: ({ params, values: { text } }) =>
      orNotFound(getAttributeWithOptions(params.id), async (attribute) => {
        await addAttributeOptionWithLog(attribute, text);
        return adminRedirect(
          "attribute",
          { id: params.id },
          t("attributes.option_added"),
          true,
        );
      }),
  },
);

const loadAttributeOption = ({ id, optionId }: AttributeOptionParams) =>
  throughParent(getAttributeWithOptions(id), (attribute) => {
    const option = attribute.options.find((item) => item.id === optionId);
    return option ? { attribute, option } : null;
  });

const attributeOptionHandler = createEntityHandler<
  AttributeOptionParams,
  AttributeOptionContext
>(loadAttributeOption);
const attributeOptionHandlers = {
  get: attributeOptionHandler(
    pageGuardFor(
      adminDestinationAt("/admin/attributes/:id/options/:optionId/delete"),
    ),
  ),
  post: attributeOptionHandler(
    formGuard(
      formPolicyFor(
        adminDestinationAt("/admin/attributes/:id/options/:optionId/delete"),
      ),
    ),
  ),
};

const handleDeleteOptionGet = attributeOptionHandlers.get(
  ({ attribute, option }, session) =>
    htmlResponse(
      adminAttributeOptionDeletePage(
        attribute,
        option,
        session,
        getFlash().error,
      ),
    ),
);

const handleEditOptionGet = attributeOptionHandlers.get(
  async ({ attribute, option }, session) => {
    const { rowsFor } = await loadAttributeListingUse(attribute.id);
    return htmlResponse(
      adminAttributeOptionEditPage(
        attribute,
        option,
        session,
        getFlash().error,
        rowsFor([option]),
      ),
    );
  },
);

const optionPath =
  (action: string) =>
  ({ id, optionId }: AttributeOptionParams): string =>
    `/admin/attributes/${id}/options/${optionId}/${action}`;

const optionDeletePath = optionPath("delete");

const handleDeleteOptionPost = createVerifiedFormRoute<
  AttributeOptionParams,
  AttributeOptionContext
>({
  actionLabel: "deletion",
  auth: formPolicyFor(
    adminDestinationAt("/admin/attributes/:id/options/:optionId/delete"),
  ),
  identifier: ({ option }) => option.text,
  identifierLabel: () => t("attributes.option_label"),
  loadContext: loadAttributeOption,
  mismatchRedirect: (_context, params) => optionDeletePath(params),
  onConfirm: verifiedDelete(
    ({ attribute, option }) => deleteAttributeOptionWithLog(attribute, option),
    ({ attribute }) => `/admin/attributes/${attribute.id}`,
    () => t("attributes.option_deleted"),
  ),
});

const handleEditOptionPost = createAuthedFormRoute<
  { text: string },
  AttributeOptionParams,
  AttributeOptionContext
>({
  auth: formPolicyFor(
    adminDestinationAt("/admin/attributes/:id/options/:optionId/edit"),
  ),
  form: attributeOptionForm,
  loadContext: loadAttributeOption,
  onInvalid: optionFormRefusal("attributeOptionEdit"),
  onValid: async ({ context: { attribute, option }, values: { text } }) => {
    await renameAttributeOptionWithLog(attribute, option, text);
    return adminRedirect(
      "attribute",
      { id: attribute.id },
      t("attributes.option_updated"),
      true,
    );
  },
});

const optionOrder = orderedListRoutes(ORDERED_LISTS.attributeOption, {
  order: attributeOptionsOrder,
  // An attribute that is gone has no options to move.
  rows: async (attributeId) =>
    (await getAttributeWithOptions(attributeId))?.options ?? null,
});

const attributeOrder = orderedListRoutes(ORDERED_LISTS.attribute, {
  order: attributesOrder,
  rows: () => idRows(getAttributeIdsOrdered()),
});

const handleListingAttributesPost = createListingChoicePost({
  feature: "attributes",
  fieldName: "optionIds",
  label: "Attributes",
  noun: "option",
  pattern: "/admin/listing/:id/attributes",
  readIds: async (form, fieldName) =>
    attributeOptionIdsIn(await form.getNumberArray(fieldName)),
  saveIds: listingAttributeOptions.setIds,
  tab: "attributes",
});

export const adminHandlers = defineAdminRoutes({
  ...listCrudRoutes(adminPattern("attributes"), pages),
  "GET /admin/attributes/:id": handleAttributeGet,
  "GET /admin/attributes/:id/options/:optionId/delete": handleDeleteOptionGet,
  "GET /admin/attributes/:id/options/:optionId/edit": handleEditOptionGet,
  ...attributeOrder,
  "POST /admin/attributes/:id/options": handleAddOption,
  "POST /admin/attributes/:id/options/:optionId/delete": handleDeleteOptionPost,
  "POST /admin/attributes/:id/options/:optionId/edit": handleEditOptionPost,
  ...optionOrder,
  "POST /admin/listing/:id/attributes": handleListingAttributesPost,
});
