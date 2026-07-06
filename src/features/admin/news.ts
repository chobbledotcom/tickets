/**
 * Admin CRUD for news posts, under Site → News. Owner + editor (the shared
 * Site-tab gates in `site-content.ts`). Posts are a flat newest-first list with
 * no ordering controls; the `/news/:slug` permalink is auto-generated on
 * create (never entered) and shown read-only on the edit page, which also
 * carries the shared images panel (image_uses with item_type 'news').
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type ConfirmedHandlers,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import { SITE_FORM, SITE_MULTIPART } from "#routes/auth.ts";
import { errorRedirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  computeNewsSlugIndex,
  createNewsPost,
  deleteNewsPostWithImages,
  getNewsPostById,
  getNewsPostSummaries,
  isNewsSlugTaken,
  type NewsPostWriteInput,
  updateNewsPost,
} from "#shared/db/news-posts.ts";
import type { FormParams } from "#shared/form-data.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { AdminSession, NewsPost } from "#shared/types.ts";
import {
  adminNewsDeletePage,
  adminNewsListPage,
  adminNewsNewPage,
} from "#templates/admin/news.tsx";
import { seoContentInput } from "./content-form-fields.ts";
import { createItemImageHandlers } from "./item-images.ts";
import { newsPostEditForm, newsPostForm } from "./news-form.ts";
import { newsPage } from "./news-page.ts";
import {
  savedContentResponse,
  siteConfirmAuth,
  siteContentGet,
  siteContentPaths,
  siteContentPost,
  siteEntityPost,
  validateContentFormOr,
} from "./site-content.ts";

/* jscpd:ignore-end */

const paths = siteContentPaths("/admin/site/news");

/** Validate the shared form fields and fold them into a write input, or
 * return the error redirect to bounce back to `errorPath`. */
const validateFields = (
  form: FormParams,
  errorPath: string,
):
  | { ok: true; input: NewsPostWriteInput }
  | { ok: false; response: Response } => {
  const result = validateContentFormOr(newsPostForm.validate(form), errorPath);
  if (!result.ok) return result;
  return {
    input: {
      ...seoContentInput(form, result.values.name),
      snippet: form.getString("snippet"),
    },
    ok: true,
  };
};

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = siteContentGet(async (session) =>
  adminNewsListPage(await getNewsPostSummaries(), session),
);

const renderNew = siteContentGet((session) => adminNewsNewPage(session));

const handleCreate = siteContentPost(async (form) => {
  const fields = validateFields(form, paths.newPage);
  if (!fields.ok) return fields.response;
  const post = await createNewsPost(fields.input);
  return savedContentResponse(
    paths.edit(post.id),
    `News post '${post.name}' created`,
    t("news.created"),
  );
});

const handleUpdate = siteEntityPost(getNewsPostById)(async (post, form) => {
  const editPath = paths.edit(post.id);
  // The edit form carries an editable slug on top of the shared content fields.
  const result = validateContentFormOr(
    newsPostEditForm.validate(form),
    editPath,
  );
  if (!result.ok) return result.response;
  // The slug field's validator already ran `validateSlug(normalizeSlug())`, so
  // the format is known-good; re-normalise for the uniqueness check and storage.
  const slug = normalizeSlug(result.values.slug);
  if (await isNewsSlugTaken(slug, post.id)) {
    return errorRedirect(editPath, t("news.error.slug_taken"));
  }
  await updateNewsPost(post.id, {
    ...seoContentInput(form, result.values.name),
    slug,
    slugIndex: await computeNewsSlugIndex(slug),
    snippet: form.getString("snippet"),
  });
  return savedContentResponse(
    editPath,
    `News post '${result.values.name}' updated`,
    t("news.updated"),
  );
});

const postDelete: ConfirmedHandlers = createConfirmedHandlers<
  NewsPost,
  AdminSession
>({
  auth: siteConfirmAuth,
  identifier: (post) => post.name,
  identifierLabel: t("news.name_label"),
  load: (id) => getNewsPostById(id),
  onConfirm: async (post) => {
    await deleteNewsPostWithImages(post.id);
    await logActivity(`News post '${post.name}' deleted`);
  },
  path: `${paths.list}/:id/delete`,
  render: (post, session, error) => adminNewsDeletePage(post, session, error),
  successMessage: t("news.deleted"),
  successRedirect: paths.list,
});

// ─── Images ─────────────────────────────────────────────────────

/** The Images tab lives at `/admin/site/news/:id/images`; its set/upload POSTs
 * bounce back there (not to the Edit tab). */
const imagesPath = (id: number): string => `${paths.list}/${id}/images`;

/** The shared per-entity image handlers, gated at the Site level (owner +
 * editor) to match the pages that link to them. */
const newsImageHandlers = createItemImageHandlers({
  auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
  disabledPath: imagesPath,
  itemType: "news",
  load: getNewsPostById,
  nameOf: (post) => post.name,
  path: imagesPath,
});

// ─── Routes ─────────────────────────────────────────────────────

export const newsRoutes = {
  ...postDelete.routes,
  ...defineRoutes({
    "GET /admin/site/news": renderList,
    "GET /admin/site/news/:id": (request, { id }) =>
      newsPage.renderTab(request, id, ""),
    "GET /admin/site/news/:id/:tab": (request, { id, tab }) =>
      newsPage.renderTab(request, id, tab),
    "GET /admin/site/news/new": renderNew,
    "POST /admin/site/news": handleCreate,
    "POST /admin/site/news/:id/edit": handleUpdate,
    "POST /admin/site/news/:id/images": newsImageHandlers.set,
    "POST /admin/site/news/:id/images/upload": newsImageHandlers.upload,
  }),
};
