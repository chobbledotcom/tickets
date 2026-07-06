/**
 * Admin CRUD for news posts, under Site → News. Owner + editor (SITE_FORM /
 * requireSiteOr, same gate as the rest of the Site tab). Posts are a flat
 * newest-first list — no slugs, no ordering controls — and each edit page
 * carries the shared images panel (image_uses with item_type 'news').
 */

import { t } from "#i18n";
import {
  type ConfirmedHandlers,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import {
  requireSiteOr,
  SITE_FORM,
  SITE_MULTIPART,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  createNewsPost,
  deleteNewsPostWithImages,
  getNewsPostById,
  getNewsPostCards,
  type NewsPostWriteInput,
  updateNewsPost,
} from "#shared/db/news-posts.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { AdminSession, NewsPost } from "#shared/types.ts";
import {
  adminNewsDeletePage,
  adminNewsEditPage,
  adminNewsListPage,
  adminNewsNewPage,
} from "#templates/admin/news.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";
import { createItemImageHandlers, loadItemImagesPanel } from "./item-images.ts";
import { newsPostForm } from "./news-form.ts";

const LIST_PATH = "/admin/site/news";
const newPath = `${LIST_PATH}/new`;
const editPath = (id: number): string => `${LIST_PATH}/${id}/edit`;

/** Validate the shared form fields and fold them into a write input, or
 * return the error redirect to bounce back to `errorPath`. */
const validateFields = (
  form: FormParams,
  errorPath: string,
):
  | { ok: true; input: NewsPostWriteInput }
  | { ok: false; response: Response } => {
  const result = newsPostForm.validate(form);
  if (!result.valid) {
    return { ok: false, response: errorRedirect(errorPath, result.error) };
  }
  return {
    input: {
      content: form.getString("content"),
      metaDescription: form.getString("meta_description"),
      metaTitle: form.getString("meta_title"),
      name: result.values.name,
      snippet: form.getString("snippet"),
    },
    ok: true,
  };
};

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = (request: Request): Promise<Response> =>
  requireSiteOr(request, async (session) =>
    htmlResponse(adminNewsListPage(await getNewsPostCards(), session)),
  );

const renderNew = (request: Request): Promise<Response> =>
  requireSiteOr(request, (session) => htmlResponse(adminNewsNewPage(session)));

const renderEdit = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  requireSiteOr(request, (session) =>
    withEntityFromParam(id, getNewsPostById, async (post) =>
      htmlResponse(
        adminNewsEditPage(
          post,
          await loadItemImagesPanel("news", post.id, `${LIST_PATH}/${post.id}`),
          session,
        ),
      ),
    ),
  );

const handleCreate = (request: Request): Promise<Response> =>
  withAuth(request, SITE_FORM, async (_session, form) => {
    const fields = validateFields(form, newPath);
    if (!fields.ok) return fields.response;
    const post = await createNewsPost(fields.input);
    await logActivity(`News post '${post.name}' created`);
    return redirect(editPath(post.id), t("news.created"), true);
  });

const handleUpdate = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withAuth(request, SITE_FORM, (_session, form) =>
    withEntityFromParam(id, getNewsPostById, async (post) => {
      const fields = validateFields(form, editPath(post.id));
      if (!fields.ok) return fields.response;
      await updateNewsPost(post.id, fields.input);
      await logActivity(`News post '${fields.input.name}' updated`);
      return redirect(editPath(post.id), t("news.updated"), true);
    }),
  );

const postDelete: ConfirmedHandlers = createConfirmedHandlers<
  NewsPost,
  AdminSession
>({
  auth: {
    requireSession: requireSiteOr,
    withForm: (r, h) => withAuth(r, SITE_FORM, h),
  },
  identifier: (post) => post.name,
  identifierLabel: t("news.name_label"),
  load: (id) => getNewsPostById(id),
  onConfirm: async (post) => {
    await deleteNewsPostWithImages(post.id);
    await logActivity(`News post '${post.name}' deleted`);
  },
  path: `${LIST_PATH}/:id/delete`,
  render: (post, session, error) => adminNewsDeletePage(post, session, error),
  successMessage: t("news.deleted"),
  successRedirect: LIST_PATH,
});

// ─── Images ─────────────────────────────────────────────────────

/** The shared per-entity image handlers, gated at the Site level (owner +
 * editor) to match the pages that link to them. */
const newsImageHandlers = createItemImageHandlers({
  auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
  disabledPath: editPath,
  itemType: "news",
  load: getNewsPostById,
  nameOf: (post) => post.name,
  path: editPath,
});

// ─── Routes ─────────────────────────────────────────────────────

export const newsRoutes = {
  ...postDelete.routes,
  ...defineRoutes({
    "GET /admin/site/news": renderList,
    "GET /admin/site/news/:id/edit": renderEdit,
    "GET /admin/site/news/new": renderNew,
    "POST /admin/site/news": handleCreate,
    "POST /admin/site/news/:id/edit": handleUpdate,
    "POST /admin/site/news/:id/images": newsImageHandlers.set,
    "POST /admin/site/news/:id/images/upload": newsImageHandlers.upload,
  }),
};
