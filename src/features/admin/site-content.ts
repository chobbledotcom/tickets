/**
 * Shared wiring for the Site tab's content editors (Pages, News): standard
 * list/new/edit paths, entity sub-action and confirmation gates, and save
 * completion (activity log + flash redirect).
 */

import { logActivity } from "#db/activity-log.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
/* jscpd:ignore-start */
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  requireSiteOr,
  SITE_FORM,
  SITE_MULTIPART,
  sitePage,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import {
  authedFormConfig,
  createAuthedFormRoute,
  type FormValidator,
} from "#shared/app-forms.ts";
import type { ParamsRoute, RequestRoute } from "#shared/response-steps.ts";
import type { Result } from "#shared/result.ts";
import type { AdminSession, ImageUseItemType } from "#types";
import type { CollectionRenderers } from "./crud-handlers.ts";
import { createItemImageHandlers } from "./item-images.ts";

/* jscpd:ignore-end */

type SavedContent = {
  flashMessage: string;
  logMessage: string;
  path: string;
};

type MaybePromise<T> = T | Promise<T>;

type ContentStep<Values, Entity, Context extends [] | [Entity]> = {
  flashMessage: string;
  logMessage: (entity: Entity, values: Values) => string;
  validate?: (
    values: Values,
    ...context: Context
  ) => MaybePromise<Response | undefined>;
  write: (
    values: Values,
    transaction: TxScope,
    ...context: Context
  ) => Promise<Entity | Response>;
};

type SiteContentDefinition<
  Entity extends { id: number },
  List,
  CreateValues,
  EditValues,
> = CollectionRenderers<List> & {
  create: ContentStep<CreateValues, Entity, []>;
  createForm: FormValidator<CreateValues>;
  delete: {
    identifier: (entity: Entity) => string;
    identifierLabel: string;
    onConfirm: (entity: Entity) => Promise<void>;
    render: (entity: Entity, session: AdminSession, error?: string) => string;
    successMessage: string;
  };
  editForm: FormValidator<EditValues>;
  entityPage: {
    renderTab: (request: Request, id: number, tab: string) => Promise<Response>;
  };
  imageType: ImageUseItemType;
  load: (id: number) => Promise<Entity | null>;
  loadList: () => Promise<List>;
  update: ContentStep<EditValues, Entity, [Entity]>;
};

type SiteContentPaths = {
  edit: (id: number) => string;
  list: string;
  newPage: string;
};

type SiteContentLifecycle = {
  create: ParamsRoute<Record<string, never>>;
  delete: ParamsRoute<{ id: number }>;
  deletePage: ParamsRoute<{ id: number }>;
  entity: ParamsRoute<{ id: number }>;
  entityTab: (
    request: Request,
    params: { id: number; tab: string },
  ) => Promise<Response>;
  images: ReturnType<typeof createItemImageHandlers>;
  list: RequestRoute;
  newPage: RequestRoute;
  paths: SiteContentPaths;
  update: ParamsRoute<{ id: number }>;
};

/** Write content and its activity row in one transaction. The callback may
 * reject before writing by returning a validation response; no activity is then
 * logged. */
export const saveContent = async <T>(
  write: (transaction: TxScope) => Promise<T | Response>,
  complete: (value: T) => SavedContent,
): Promise<Response> => {
  const saved = await withTransaction(async (transaction) => {
    const value = await write(transaction);
    if (value instanceof Response) return value;
    const completion = complete(value);
    await logActivity(completion.logMessage, undefined, undefined, transaction);
    return completion;
  });
  return saved instanceof Response
    ? saved
    : redirect(saved.path, saved.flashMessage, true);
};

/** Turn a conditional content write into its saved value or the standard form
 * response for the reason it did not write. */
export const contentWriteOrError = <T>(
  result: Result<T, "notFound" | "slugTaken">,
  path: string,
  slugError: string,
): T | Response =>
  result.ok
    ? result.value
    : result.error === "notFound"
      ? notFoundResponse()
      : errorRedirect(path, slugError);

/** Define the standard Site content lifecycle while leaving domain validation,
 * writes, messages, logs, tabs, and image paths with the caller. */
export const defineSiteContent = <
  Entity extends { id: number },
  List,
  CreateValues,
  EditValues,
>(
  basePath: string,
  define: (
    paths: SiteContentPaths,
  ) => SiteContentDefinition<Entity, List, CreateValues, EditValues>,
): SiteContentLifecycle => {
  const paths = {
    edit: (id: number): string => `${basePath}/${id}/edit`,
    list: basePath,
    newPage: `${basePath}/new`,
  };
  const definition = define(paths);
  const loadEntity = ({ id }: { id: number }): Promise<Entity | null> =>
    definition.load(id);
  const create = createAuthedFormRoute({
    ...authedFormConfig(SITE_FORM, definition.createForm, () => paths.newPage),
    onValid: async ({ values }) => {
      const error = await definition.create.validate?.(values);
      return error
        ? error
        : saveContent(
            (transaction) => definition.create.write(values, transaction),
            (entity) => ({
              flashMessage: definition.create.flashMessage,
              logMessage: definition.create.logMessage(entity, values),
              path: paths.edit(entity.id),
            }),
          );
    },
  });
  const update = createAuthedFormRoute({
    ...authedFormConfig(
      SITE_FORM,
      definition.editForm,
      (entity: Entity) => paths.edit(entity.id),
      loadEntity,
    ),
    onValid: async ({ context: entity, values }) => {
      const error = await definition.update.validate?.(values, entity);
      return error
        ? error
        : saveContent(
            (transaction) =>
              definition.update.write(values, transaction, entity),
            (saved) => ({
              flashMessage: definition.update.flashMessage,
              logMessage: definition.update.logMessage(saved, values),
              path: paths.edit(saved.id),
            }),
          );
    },
  });
  const confirmedDelete = createConfirmedHandlers<Entity, AdminSession>({
    auth: {
      requireSession: requireSiteOr,
      withForm: (request, handler) => withAuth(request, SITE_FORM, handler),
    },
    ...definition.delete,
    load: definition.load,
    onConfirm: async (entity) => {
      await definition.delete.onConfirm(entity);
      return;
    },
    path: `${paths.list}/:id/delete`,
    successRedirect: paths.list,
  });
  return {
    create,
    delete: (request, { id }) => confirmedDelete.post(request, id),
    deletePage: (request, { id }) => confirmedDelete.get(request, id),
    entity: (request, { id }) =>
      definition.entityPage.renderTab(request, id, ""),
    entityTab: (request, { id, tab }) =>
      definition.entityPage.renderTab(request, id, tab),
    images: createItemImageHandlers({
      auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
      disabledPath: paths.edit,
      itemType: definition.imageType,
      load: definition.load,
      nameOf: definition.delete.identifier,
      path: (id) => `${paths.list}/${id}/images`,
    }),
    list: sitePage(async (session, _request, flash) =>
      definition.renderList(
        await definition.loadList(),
        session,
        flash.success,
      ),
    ),
    newPage: sitePage((session, _request, flash) =>
      definition.renderNew(session, flash.error),
    ),
    paths,
    update,
  };
};
