/**
 * Admin CRUD for news posts, under Site → News. Owner + editor (the shared
 * Site-tab gates in `site-content.ts`). Posts are a flat newest-first list with
 * no ordering controls; the `/news/:slug` permalink is auto-generated on
 * create (never entered) and editable on the edit page, which also
 * carries the shared images panel (image_uses with item_type 'news').
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  createNewsPost,
  deleteNewsPostWithImages,
  getNewsPostById,
  getNewsPostSummaries,
  type NewsPostWriteInput,
  updateNewsPost,
} from "#shared/db/news-posts.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { NewsPost } from "#shared/types.ts";
import {
  adminNewsDeletePage,
  adminNewsListPage,
  adminNewsNewPage,
} from "#templates/admin/news.tsx";
import { seoContentInput } from "./content-form-fields.ts";
import { newsPostEditForm, newsPostForm } from "./news-form.ts";
import { newsPage } from "./news-page.ts";
import { contentWriteOrError, defineSiteContent } from "./site-content.ts";

/* jscpd:ignore-end */

type NewsContentValues = Parameters<typeof seoContentInput>[0] & {
  snippet: string;
};

/** Turn the validated fields shared by both news forms into a write input. */
const newsContentInput = (values: NewsContentValues): NewsPostWriteInput => ({
  ...seoContentInput(values),
  snippet: values.snippet,
});

const content = defineSiteContent("/admin/site/news", (paths) => ({
  create: {
    flashMessage: t("news.created"),
    logMessage: (post: NewsPost) => `News post '${post.name}' created`,
    write: (values: NewsContentValues, transaction) =>
      createNewsPost(newsContentInput(values), transaction),
  },
  createForm: newsPostForm,
  delete: {
    identifier: (post: NewsPost) => post.name,
    identifierLabel: t("news.name_label"),
    onConfirm: async (post: NewsPost) => {
      await deleteNewsPostWithImages(post.id);
      await logActivity(`News post '${post.name}' deleted`);
    },
    render: adminNewsDeletePage,
    successMessage: t("news.deleted"),
  },
  editForm: newsPostEditForm,
  entityPage: newsPage,
  imageType: "news",
  load: getNewsPostById,
  loadList: getNewsPostSummaries,
  renderList: adminNewsListPage,
  renderNew: adminNewsNewPage,
  update: {
    flashMessage: t("news.updated"),
    logMessage: (
      _post: NewsPost,
      values: NewsContentValues & { slug: string },
    ) => `News post '${values.name}' updated`,
    write: async (
      values: NewsContentValues & { slug: string },
      transaction,
      post,
    ) =>
      contentWriteOrError(
        await updateNewsPost(
          post.id,
          {
            ...newsContentInput(values),
            // The form validator already checked the normalized slug's format.
            slug: normalizeSlug(values.slug),
          },
          transaction,
        ),
        paths.edit(post.id),
        t("news.error.slug_taken"),
      ),
  },
}));

// ─── Routes ─────────────────────────────────────────────────────

export const adminHandlers = defineRoutes({
  "GET /admin/site/news": content.list,
  "GET /admin/site/news/:id": content.entity,
  "GET /admin/site/news/:id/:tab": content.entityTab,
  "GET /admin/site/news/:id/delete": content.deletePage,
  "GET /admin/site/news/new": content.newPage,
  "POST /admin/site/news": content.create,
  "POST /admin/site/news/:id/delete": content.delete,
  "POST /admin/site/news/:id/edit": content.update,
  "POST /admin/site/news/:id/images": content.images.set,
  "POST /admin/site/news/:id/images/upload": content.images.upload,
});
