import { handlersFor } from "#routes/admin/handlers.ts";
import { planReorder } from "#shared/reorder.ts";
/**
 * Admin routes for listing attributes.
 */

/* jscpd:ignore-start */
import {
  createConfirmedHandlers,
  createVerifiedFormRoute,
} from "#routes/admin/confirmation.ts";
import {
  formGuard,
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
} from "#routes/auth.ts";
import {
  createEntityHandler,
  orNotFound,
  ownerGetById,
} from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import {
  createAuthedFormRoute,
  createAuthedHandler,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  type AttributeOption,
  type AttributeWithOptions,
  assignNextAttributeSortOrder,
  attributeOptionsTable,
  attributesTable,
  deleteAttribute,
  deleteAttributeOption,
  getAllAttributeOptionIds,
  getAllAttributesWithOptions,
  getAttributeId,
  getAttributeIdsOrdered,
  getAttributeListingUse,
  getAttributeWithOptions,
  getNextAttributeOptionSortOrder,
  listingAttributeOptions,
  pruneInvalidAttributeOptionIds,
  swapAttributeOptionOrder,
  swapAttributeOrder,
} from "#shared/db/attributes.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms/definition.ts";
import {
  adminAttributeDeletePage,
  adminAttributeOptionDeletePage,
  adminAttributeOptionEditPage,
  adminAttributePage,
  adminAttributesPage,
  attributeNameFlat,
} from "#templates/admin/attributes.tsx";
import {
  attributeListingRows,
  optionListingCounts,
} from "./attribute-page-data.ts";
import { createListingChoicePost } from "./listing-choice-post.ts";
/* jscpd:ignore-end */

export const attributeNameForm = defineForm({
  fields: [
    {
      label: "Attribute name",
      name: "name",
      placeholder: "e.g. Difficulty",
      required: true,
      type: "text",
    },
  ] as const,
  id: "attributeName",
});

export const attributeOptionForm = defineForm({
  fields: [
    {
      label: "Option text",
      name: "text",
      placeholder: "e.g. Beginner",
      required: true,
      type: "text",
    },
  ] as const,
  id: "attributeOption",
});

const handleAttributesGet = ownerPage(async (session) => {
  const flash = getFlash();
  return adminAttributesPage(
    await getAllAttributesWithOptions(),
    session,
    flash.error,
  );
});

const handleAttributesPost = createAuthedFormRoute({
  auth: OWNER_FORM,
  form: attributeNameForm,
  onInvalid: ({ error }) => errorRedirect("/admin/attributes", error),
  onValid: async ({ values: { name } }) => {
    const attribute = await attributesTable.insert({ name });
    await assignNextAttributeSortOrder(attribute.id);
    await logActivity(`Attribute '${name}' created`);
    return redirect(
      `/admin/attributes/${attribute.id}`,
      "Attribute created",
      true,
    );
  },
});

/** The listing usage both detail pages show: which listings selected each of
 * the attribute's options, as per-option counts plus a builder that turns any
 * subset of the options into "listings using this" table rows. */
const loadAttributeListingUse = async (attributeId: number) => {
  const { listingIdsByOption, listings } =
    await getAttributeListingUse(attributeId);
  return {
    listingCounts: optionListingCounts(listingIdsByOption),
    rowsFor: (options: AttributeOption[]) =>
      attributeListingRows(options, listingIdsByOption, listings),
  };
};

const handleAttributeGet = ownerGetById(
  getAttributeWithOptions,
  async (attribute, session) => {
    const { listingCounts, rowsFor } = await loadAttributeListingUse(
      attribute.id,
    );
    return htmlResponse(
      adminAttributePage(attribute, session, getFlash().error, {
        listingCounts,
        listings: rowsFor(attribute.options),
      }),
    );
  },
);

type AttributeParams = { id: number };
type AttributeOptionParams = { id: number; optionId: number };
type AttributeOptionContext = {
  attribute: AttributeWithOptions;
  option: AttributeOption;
};

const redirectToAttribute = (args: {
  error: string;
  params: AttributeParams;
}): Response =>
  errorRedirect(`/admin/attributes/${args.params.id}`, args.error);

const logAttributeOptionActivity = (
  optionText: string,
  action: string,
  attribute: AttributeWithOptions,
) =>
  logActivity(
    `Attribute option '${optionText}' ${action} ${attributeNameFlat(
      attribute.name,
    )}`,
  );

const handleAttributeEdit = createAuthedFormRoute<
  { name: string },
  AttributeParams
>({
  auth: OWNER_FORM,
  form: attributeNameForm,
  onInvalid: redirectToAttribute,
  onValid: ({ params, values: { name } }) =>
    orNotFound(getAttributeWithOptions(params.id), async () => {
      await attributesTable.update(params.id, { name });
      await logActivity(`Attribute '${name}' updated`);
      return redirect(
        `/admin/attributes/${params.id}`,
        "Attribute updated",
        true,
      );
    }),
});

const handleAddOption = createAuthedFormRoute<
  { text: string },
  AttributeParams
>({
  auth: OWNER_FORM,
  form: attributeOptionForm,
  onInvalid: redirectToAttribute,
  onValid: ({ params, values: { text } }) =>
    orNotFound(getAttributeWithOptions(params.id), async (attribute) => {
      await attributeOptionsTable.insert({
        attributeId: params.id,
        sortOrder: await getNextAttributeOptionSortOrder(params.id),
        text,
      });
      await logAttributeOptionActivity(text, "added to", attribute);
      return redirect(`/admin/attributes/${params.id}`, "Option added", true);
    }),
});

const attributeDelete = createConfirmedHandlers<AttributeWithOptions>({
  identifier: (attribute) => attributeNameFlat(attribute.name),
  identifierLabel: "Attribute name",
  load: (id) => getAttributeWithOptions(id),
  onConfirm: async (attribute) => {
    await deleteAttribute(attribute.id);
    await logActivity(`Attribute '${attribute.name}' deleted`);
  },
  path: "/admin/attributes/:id/delete",
  render: (attribute, session, error) =>
    adminAttributeDeletePage(attribute, session, error),
  successMessage: "Attribute deleted",
  successRedirect: "/admin/attributes",
});

const loadAttributeOption = async ({
  id,
  optionId,
}: AttributeOptionParams): Promise<AttributeOptionContext | null> => {
  const attribute = await getAttributeWithOptions(id);
  const option = attribute?.options.find((item) => item.id === optionId);
  return attribute && option ? { attribute, option } : null;
};

const attributeOptionHandler = createEntityHandler<
  AttributeOptionParams,
  AttributeOptionContext
>(loadAttributeOption);
const attributeOptionHandlers = {
  get: attributeOptionHandler(requireOwnerOr),
  post: attributeOptionHandler(formGuard(OWNER_FORM)),
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

/** Build the URL of an option sub-action (delete, edit) for a given option. */
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
  auth: OWNER_FORM,
  identifier: ({ option }) => option.text,
  identifierLabel: "Option text",
  loadContext: loadAttributeOption,
  mismatchRedirect: (_context, params) => optionDeletePath(params),
  onConfirm: async ({ context: { attribute, option } }) => {
    await deleteAttributeOption(option.id);
    await logAttributeOptionActivity(option.text, "deleted from", attribute);
    return redirect(
      `/admin/attributes/${attribute.id}`,
      "Option deleted",
      true,
    );
  },
});

const editOptionPath = optionPath("edit");

const handleEditOptionPost = createAuthedFormRoute<
  { text: string },
  AttributeOptionParams,
  AttributeOptionContext
>({
  auth: OWNER_FORM,
  form: attributeOptionForm,
  loadContext: loadAttributeOption,
  onInvalid: ({ error, params }) =>
    errorRedirect(editOptionPath(params), error),
  onValid: async ({ context: { attribute, option }, values: { text } }) => {
    await attributeOptionsTable.update(option.id, { text });
    await logAttributeOptionActivity(text, "updated in", attribute);
    return redirect(
      `/admin/attributes/${attribute.id}`,
      "Option updated",
      true,
    );
  },
});

const moveOptionHandler = (dir: "up" | "down") =>
  attributeOptionHandlers.post(async ({ attribute, option }) => {
    const pair = planReorder(
      attribute.options.map((item) => item.id),
      option.id,
      dir,
    );
    if (pair) await swapAttributeOptionOrder(pair[0], pair[1]);
    return redirect(`/admin/attributes/${attribute.id}`, "Option moved", true);
  });

const moveAttributeHandler = (dir: "up" | "down") =>
  createAuthedHandler<AttributeParams, number>({
    auth: OWNER_FORM,
    handle: async ({ context: attributeId }) => {
      const attributeIds = await getAttributeIdsOrdered();
      const pair = planReorder(attributeIds, attributeId, dir);
      if (pair) await swapAttributeOrder(pair[0], pair[1]);
      return redirect("/admin/attributes", "Attribute moved", true);
    },
    loadContext: ({ id }) => getAttributeId(id),
  });

const handleListingAttributesPost = createListingChoicePost({
  fieldName: "option_ids",
  label: "Attributes",
  noun: "option",
  readIds: async (form) =>
    pruneInvalidAttributeOptionIds(
      await getAllAttributeOptionIds(),
      form.getNumberArray("option_ids"),
    ),
  saveIds: listingAttributeOptions.setIds,
  tab: "attributes",
});

export const adminHandlers = handlersFor("attributes")({
  getAttributes: handleAttributesGet,
  getAttributesById: handleAttributeGet,
  getAttributesByIdDelete: (request, { id }) =>
    attributeDelete.get(request, id),
  getAttributesByIdOptionsByOptionIdDelete: handleDeleteOptionGet,
  getAttributesByIdOptionsByOptionIdEdit: handleEditOptionGet,
  postAttributes: handleAttributesPost,
  postAttributesByIdDelete: (request, { id }) =>
    attributeDelete.post(request, id),
  postAttributesByIdEdit: handleAttributeEdit,
  postAttributesByIdMoveDown: moveAttributeHandler("down"),
  postAttributesByIdMoveUp: moveAttributeHandler("up"),
  postAttributesByIdOptions: handleAddOption,
  postAttributesByIdOptionsByOptionIdDelete: handleDeleteOptionPost,
  postAttributesByIdOptionsByOptionIdEdit: handleEditOptionPost,
  postAttributesByIdOptionsByOptionIdMoveDown: moveOptionHandler("down"),
  postAttributesByIdOptionsByOptionIdMoveUp: moveOptionHandler("up"),
  postListingByIdAttributes: handleListingAttributesPost,
});
