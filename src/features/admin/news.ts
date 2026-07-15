import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin CRUD for news posts, under Site → News. Owner + editor (the shared
 * Site-tab gates in `site-content.ts`). Posts are a flat newest-first list with
 * no ordering controls; the `/news/:slug` permalink is auto-generated on
 * create (never entered) and editable on the edit page, which also
 * carries the shared images panel (image_uses with item_type 'news').
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type ConfirmedHandlers,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import { SITE_FORM, SITE_MULTIPART, sitePage } from "#routes/auth.ts";
import { errorRedirect } from "#routes/response.ts";
import { authedFormConfig, createAuthedFormRoute } from "#shared/app-forms.ts";
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
import { normalizeSlug } from "#shared/slug.ts";
import type { AdminSession, NewsPost } from "#shared/types.ts";
import {
  adminNewsDeletePage,
  adminNewsListPage,
  adminNewsNewPage,
} from "#templates/admin/news.tsx";
import { seoContentInput, textOrEmpty } from "./content-form-fields.ts";
import { createItemImageHandlers } from "./item-images.ts";
import { newsPostEditForm, newsPostForm } from "./news-form.ts";
import { newsPage } from "./news-page.ts";
import {
  savedContentResponse,
  siteConfirmAuth,
  siteContentPaths,
  siteListPage,
} from "./site-content.ts";

/* jscpd:ignore-end */

const paths = siteContentPaths("/admin/site/news");

type NewsContentValues = Parameters<typeof seoContentInput>[0] & {
  snippet: string | null;
};

/** Turn the validated fields shared by both news forms into a write input. */
const newsContentInput = (values: NewsContentValues): NewsPostWriteInput => ({
  ...seoContentInput(values),
  snippet: textOrEmpty(values.snippet),
});

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = siteListPage(getNewsPostSummaries, adminNewsListPage);

const renderNew = sitePage((session, _request, flash) =>
  adminNewsNewPage(session, flash.error),
);

const loadPost = ({ id }: { id: number }): Promise<NewsPost | null> =>
  getNewsPostById(id);
const postEditPath = (post: NewsPost): string => paths.edit(post.id);
const createPostForm = authedFormConfig(
  SITE_FORM,
  newsPostForm,
  () => paths.newPage,
);
const editPostForm = authedFormConfig(
  SITE_FORM,
  newsPostEditForm,
  postEditPath,
  loadPost,
);
const handleCreate = createAuthedFormRoute({
  ...createPostForm,
  onValid: async ({ values }) => {
    const post = await createNewsPost(newsContentInput(values));
    return savedContentResponse(
      paths.edit(post.id),
      `News post '${post.name}' created`,
      t("news.created"),
    );
  },
});
const handleUpdate = createAuthedFormRoute({
  ...editPostForm,
  onValid: async ({ context: post, values }) => {
    const editPath = paths.edit(post.id);
    // The form validator already checked the normalized slug's format.
    const slug = normalizeSlug(values.slug);
    if (await isNewsSlugTaken(slug, post.id)) {
      return errorRedirect(editPath, t("news.error.slug_taken"));
    }
    await updateNewsPost(post.id, {
      ...newsContentInput(values),
      slug,
      slugIndex: await computeNewsSlugIndex(slug),
    });
    return savedContentResponse(
      editPath,
      `News post '${values.name}' updated`,
      t("news.updated"),
    );
  },
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
