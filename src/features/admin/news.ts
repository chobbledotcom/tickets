/**
 * Admin CRUD for news posts, under Site → News. Owner + editor (the site
 * gates). Posts are a flat newest-first list with no ordering controls. The
 * news record owns the writes. The entity page and the image panel are the
 * custom routes beside the generated six.
 */

import { getNewsPostById } from "#db/news-posts.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { newsRecord } from "#shared/records/news.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { normalizeSlug } from "#shared/slug.ts";
import {
  adminNewsDeletePage,
  adminNewsListPage,
  adminNewsNewPage,
} from "#templates/admin/news.tsx";
import { seoContentInput } from "./content-form-fields.ts";
import {
  contentImageHandlers,
  contentPagePaths,
  contentRecordRoutes,
} from "./content-save.ts";
import { newsPostEditForm, newsPostForm } from "./news-form.ts";
import { newsPage } from "./news-page.ts";

type NewsContentValues = Parameters<typeof seoContentInput>[0] & {
  snippet: string;
};

const newsContentInput = (values: NewsContentValues) => ({
  ...seoContentInput(values),
  snippet: values.snippet,
});

const pages = recordPages(newsRecord, {
  ...contentPagePaths(newsRecord),
  editForm: newsPostEditForm,
  form: newsPostForm,
  renderDelete: adminNewsDeletePage,
  renderEditError: newsPage.renderEditError,
  renderList: adminNewsListPage,
  renderNew: adminNewsNewPage,
  toEditInput: (values: NewsContentValues & { slug: string }) => ({
    ...newsContentInput(values),
    slug: normalizeSlug(values.slug),
  }),
  toInput: newsContentInput,
});

const images = contentImageHandlers({
  itemType: "news",
  load: getNewsPostById,
  nameOf: (post) => post.name,
  record: newsRecord,
});

export const adminHandlers = defineAdminRoutes({
  ...contentRecordRoutes("news", pages, images, newsPage),
});
