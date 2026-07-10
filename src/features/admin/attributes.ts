/**
 * Admin routes for listing attributes.
 */

/* jscpd:ignore-start */
import {
  createConfirmedHandlers,
  createVerifiedFormRoute,
} from "#routes/admin/confirmation.ts";
import { OWNER_FORM, ownerPage, requireOwnerOr } from "#routes/auth.ts";
import { ownerGetById } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthedHandlerArgs,
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
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  getNextAttributeOptionSortOrder,
  pruneInvalidAttributeOptionIds,
  setListingAttributeOptions,
  swapAttributeOptionOrder,
  swapAttributeOrder,
} from "#shared/db/attributes.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms.tsx";
import {
  adminAttributeDeletePage,
  adminAttributeOptionDeletePage,
  adminAttributePage,
  adminAttributesPage,
  attributeNameFlat,
} from "#templates/admin/attributes.tsx";
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

const handleAttributeGet = ownerGetById(
  getAttributeWithOptions,
  (attribute, session) =>
    htmlResponse(adminAttributePage(attribute, session, getFlash().error)),
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

const withAttribute = async (
  id: number,
  handle: (attribute: AttributeWithOptions) => Promise<Response>,
): Promise<Response> => {
  const attribute = await getAttributeWithOptions(id);
  return attribute ? handle(attribute) : notFoundResponse();
};

const handleAttributeEdit = createAuthedFormRoute<
  { name: string },
  AttributeParams
>({
  auth: OWNER_FORM,
  form: attributeNameForm,
  onInvalid: redirectToAttribute,
  onValid: ({ params, values: { name } }) =>
    withAttribute(params.id, async () => {
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
    withAttribute(params.id, async (attribute) => {
      await attributeOptionsTable.insert({
        attributeId: params.id,
        sortOrder: await getNextAttributeOptionSortOrder(params.id),
        text,
      });
      await logActivity(`Attribute option '${text}' added to ${attribute.id}`);
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

const optionRoute =
  (
    handler: (
      attribute: AttributeWithOptions,
      option: AttributeOption,
      session: Parameters<typeof adminAttributeOptionDeletePage>[2],
    ) => Response,
  ) =>
  (request: Request, params: AttributeOptionParams): Promise<Response> =>
    requireOwnerOr(request, async (session) => {
      const context = await loadAttributeOption(params);
      if (!context) return notFoundResponse();
      return handler(context.attribute, context.option, session);
    });

const handleDeleteOptionGet = optionRoute((attribute, option, session) =>
  htmlResponse(
    adminAttributeOptionDeletePage(
      attribute,
      option,
      session,
      getFlash().error,
    ),
  ),
);

const optionDeletePath = ({ id, optionId }: AttributeOptionParams): string =>
  `/admin/attributes/${id}/options/${optionId}/delete`;

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
    await logActivity(
      `Attribute option '${option.text}' deleted from ${attribute.id}`,
    );
    return redirect(
      `/admin/attributes/${attribute.id}`,
      "Option deleted",
      true,
    );
  },
});

const editOptionPath = ({ id }: AttributeOptionParams): string =>
  `/admin/attributes/${id}`;

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
    await logActivity(`Attribute option '${text}' updated in ${attribute.id}`);
    return redirect(
      `/admin/attributes/${attribute.id}`,
      "Option updated",
      true,
    );
  },
});

const optionActionHandler = (
  handle: (
    args: AuthedHandlerArgs<AttributeOptionParams, AttributeOptionContext>,
  ) => Response | Promise<Response>,
) =>
  createAuthedHandler<AttributeOptionParams, AttributeOptionContext>({
    auth: OWNER_FORM,
    handle,
    loadContext: loadAttributeOption,
  });

const moveOptionHandler = (direction: -1 | 1) =>
  optionActionHandler(async ({ context: { attribute, option } }) => {
    const index = attribute.options.findIndex((item) => item.id === option.id);
    const neighbor = attribute.options[index + direction];
    if (neighbor) await swapAttributeOptionOrder(option.id, neighbor.id);
    return redirect(`/admin/attributes/${attribute.id}`, "Option moved", true);
  });

const moveAttributeHandler = (direction: -1 | 1) =>
  createAuthedHandler<AttributeParams, AttributeWithOptions>({
    auth: OWNER_FORM,
    handle: async ({ context: attribute }) => {
      const attributes = await getAllAttributesWithOptions();
      const index = attributes.findIndex((item) => item.id === attribute.id);
      const neighbor = attributes[index + direction];
      if (neighbor) await swapAttributeOrder(attribute.id, neighbor.id);
      return redirect("/admin/attributes", "Attribute moved", true);
    },
    loadContext: ({ id }) => getAttributeWithOptions(id),
  });

const handleListingAttributesPost = createListingChoicePost({
  fieldName: "option_ids",
  label: "Attributes",
  noun: "option",
  readIds: async (form) =>
    pruneInvalidAttributeOptionIds(
      await getAllAttributesWithOptions(),
      form.getNumberArray("option_ids"),
    ),
  saveIds: setListingAttributeOptions,
  tab: "attributes",
});

export const attributesRoutes = {
  ...attributeDelete.routes,
  ...defineRoutes({
    "GET /admin/attributes": handleAttributesGet,
    "GET /admin/attributes/:id": handleAttributeGet,
    "GET /admin/attributes/:id/options/:optionId/delete": handleDeleteOptionGet,
    "POST /admin/attributes": handleAttributesPost,
    "POST /admin/attributes/:id/edit": handleAttributeEdit,
    "POST /admin/attributes/:id/move-down": moveAttributeHandler(1),
    "POST /admin/attributes/:id/move-up": moveAttributeHandler(-1),
    "POST /admin/attributes/:id/options": handleAddOption,
    "POST /admin/attributes/:id/options/:optionId/delete":
      handleDeleteOptionPost,
    "POST /admin/attributes/:id/options/:optionId/edit": handleEditOptionPost,
    "POST /admin/attributes/:id/options/:optionId/move-down":
      moveOptionHandler(1),
    "POST /admin/attributes/:id/options/:optionId/move-up":
      moveOptionHandler(-1),
    "POST /admin/listing/:id/attributes": handleListingAttributesPost,
  }),
};
