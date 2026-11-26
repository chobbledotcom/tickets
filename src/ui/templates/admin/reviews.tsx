/** Admin reviews list, add, edit, and delete pages. The shared record pages
 *  render the shell. This file owns only the review columns and edit form. */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { reviewRecord } from "#shared/records/reviews.ts";
import type { Review } from "#shared/reviews/types.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import {
  type AdminResourcePages,
  confirmDeleteSpec,
  defineRecordPages,
  deleteLinkColumn,
  recordPageConfig,
  writableNameColumn,
} from "#templates/admin/resource-pages.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { getReviewForm, reviewFormValues } from "#templates/fields/reviews.ts";
import type { AdminSession } from "#types";

const reviewColumns = (): TableColumn<Review>[] => [
  writableNameColumn(
    (review) => `/admin/site/reviews/${review.id}/edit`,
    (review) => review.name,
  ),
  translatedTableColumn("rating", "reviews.col.rating", (review) =>
    String(review.rating),
  ),
  translatedTableColumn("date", "reviews.col.date", (review) =>
    formatDateLabel(review.date),
  ),
  translatedTableColumn("url", "reviews.col.url", (review) => (
    <a href={review.url} rel="nofollow noopener noreferrer" target="_blank">
      {review.url}
    </a>
  )),
  deleteLinkColumn((review) => `/admin/site/reviews/${review.id}/delete`),
];

const renderFields = (review: Review | undefined) => (
  <Raw
    html={getReviewForm().render(review ? reviewFormValues(review) : undefined)}
  />
);

/* jscpd:ignore-start -- static page config, not code */
const reviewList = {
  addLabelKey: "reviews.add.submit",
  emptyKey: "reviews.list.empty",
  guideAnchor: "settings",
  introKey: "reviews.list.intro",
  resource: "reviews",
  route: "reviewNew",
} as const;
/* jscpd:ignore-end */

export const getReviewPages = (): AdminResourcePages<Review> =>
  defineRecordPages(
    reviewRecord,
    recordPageConfig(
      "reviews",
      reviewColumns(),
      reviewList,
      confirmDeleteSpec<Review>({
        label: t("reviews.delete.confirm_label"),
        name: (review) => review.name,
        resource: "reviews",
      }),
      renderFields,
    ),
  );

/** One review's edit page. */
export const adminReviewEditPage = (
  review: Review,
  session: AdminSession,
  error?: string | undefined,
): string =>
  renderAdminPageSpec({
    active: "/admin/site/reviews",
    body: (
      <SaveForm
        action={`/admin/site/reviews/${review.id}/edit`}
        submitLabel={t("common.save")}
      >
        <h1>{t("reviews.edit.heading")}</h1>
        {renderFields(review)}
      </SaveForm>
    ),
    flash: { error },
    session,
    title: t("reviews.edit.title"),
  });
