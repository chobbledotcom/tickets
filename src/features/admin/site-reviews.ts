/** Admin reviews routes: list, add, edit, and delete one review. The shared
 *  record pages own the writes. This module binds them to the Site routes. */

import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { entityPageById } from "#routes/entity.ts";
import { htmlResponse } from "#routes/response.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { getFlash } from "#shared/flash-context.ts";
import { reviewRecord } from "#shared/records/reviews.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  adminReviewEditPage,
  getReviewPages,
} from "#templates/admin/reviews.tsx";
import {
  getReviewForm,
  reviewInputFromForm,
} from "#templates/fields/reviews.ts";

const views = getReviewPages();

const pages = recordPages(reviewRecord, {
  form: getReviewForm(),
  renderDelete: (review, session, error) =>
    views.deletePage(review, session, error),
  renderList: (rows, session, success) =>
    views.listPage(rows, session, undefined, success),
  renderNew: (session, error) => views.newPage(session, error),
  routes: { delete: "reviewDelete", edit: "reviewEdit" },
  savePath: () => "/admin/site/reviews",
  toInput: reviewInputFromForm,
  updateSavePath: () => "/admin/site/reviews",
});

const handleReviewEditGet = entityPageById(
  adminPattern("reviewEdit"),
  (id) => reviewRecord.load(id),
  (review, session) =>
    htmlResponse(adminReviewEditPage(review, session, getFlash().error)),
);

export const adminHandlers = defineAdminRoutes({
  "GET /admin/site/reviews": pages.listGet,
  "GET /admin/site/reviews/:id/delete": pages.deleteGet,
  "GET /admin/site/reviews/:id/edit": handleReviewEditGet,
  "GET /admin/site/reviews/new": pages.newGet,
  "POST /admin/site/reviews": pages.createPost,
  "POST /admin/site/reviews/:id/delete": pages.deletePost,
  "POST /admin/site/reviews/:id/edit": pages.editPost,
});
