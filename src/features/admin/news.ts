import { handlersFor } from "#routes/admin/handlers.ts";
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
import { checkContentForm } from "./check-content-form.ts";
import { seoContentInput } from "./content-form-fields.ts";
import { createItemImageHandlers } from "./item-images.ts";
import { newsPostEditForm, newsPostForm } from "./news-form.ts";
import { newsPage } from "./news-page.ts";
import {
  savedContentResponse,
  siteConfirmAuth,
  siteContentGet,
  siteContentPaths,
  siteEntityPost,
  validateContentFormOr,
} from "./site-content.ts";
import { siteCreatePost } from "./site-content-create.ts";

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
  const result = checkContentForm(newsPostForm, form, errorPath);
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

const renderNew = siteContentGet(adminNewsNewPage);

const handleCreate = siteCreatePost(
  paths.newPage,
  validateFields,
  async (fields) => {
    const post = await createNewsPost(fields.input);
    return {
      flashMessage: t("news.created"),
      logMessage: `News post '${post.name}' created`,
      path: paths.edit(post.id),
    };
  },
);

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
 * editor) to match the pages that link to them. A successful save stays on the
 * Images tab, but a storage-disabled bounce redirects to the Edit tab: the
 * Images tab is hidden when storage is off, so a redirect there would 404 and
 * swallow the "storage not configured" message. */
const newsImageHandlers = createItemImageHandlers({
  auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
  disabledPath: paths.edit,
  itemType: "news",
  load: getNewsPostById,
  nameOf: (post) => post.name,
  path: imagesPath,
});

// ─── Routes ─────────────────────────────────────────────────────

export const adminHandlers = handlersFor("news")({
  getSiteNews: renderList,
  getSiteNewsById: (request, { id }) => newsPage.renderTab(request, id, ""),
  getSiteNewsByIdByTab: (request, { id, tab }) =>
    newsPage.renderTab(request, id, tab),
  getSiteNewsByIdDelete: (request, { id }) => postDelete.get(request, id),
  getSiteNewsNew: renderNew,
  postSiteNews: handleCreate,
  postSiteNewsByIdDelete: (request, { id }) => postDelete.post(request, id),
  postSiteNewsByIdEdit: handleUpdate,
  postSiteNewsByIdImages: newsImageHandlers.set,
  postSiteNewsByIdImagesUpload: newsImageHandlers.upload,
});
