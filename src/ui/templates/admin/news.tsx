/**
 * Admin templates for Site → News: the newest-first list, the create form, the
 * Edit-tab panel (the pre-filled fields form, posting to the update route), and
 * the delete confirmation. The edit page itself is the shared tabbed entity page
 * (Edit / Images / Actions) built in `#routes/admin/news-page.ts`; this file
 * only supplies the Edit tab's form.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  newsPostEditForm,
  newsPostForm,
  newsPostToValues,
} from "#routes/admin/news-form.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, NewsPost, NewsPostSummary } from "#shared/types.ts";
import { adminFormPage } from "#templates/admin/admin-page.tsx";
import {
  collectionPage,
  deleteConfirmPage,
} from "#templates/admin/site-content.tsx";
import {
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";

/* jscpd:ignore-end */

const LIST = "/admin/site/news";
const ACTIVE = LIST;

export const adminNewsListPage = (
  posts: NewsPostSummary[],
  session: AdminSession,
  successMessage?: string,
): string =>
  collectionPage("news", LIST)(
    session,
    successMessage,
    posts.length === 0 ? (
      <p>
        <em>{t("news.none")}</em>
      </p>
    ) : (
      <DataTable
        columns={[
          { header: t("news.name_column") },
          { header: t("news.created_column") },
          { header: "" },
        ]}
        rows={posts.map((post) => [
          <a href={`${LIST}/${post.id}/edit`}>{post.name}</a>,
          formatDatetimeShort(post.created),
          <a href={`${LIST}/${post.id}/delete`}>{t("common.delete")}</a>,
        ])}
      />
    ),
  );

export const adminNewsNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  adminFormPage({
    action: LIST,
    active: ACTIVE,
    children: (
      <>
        <Raw html={newsPostForm.renderFields()} />
        <SubmitButton icon="plus">{t("news.create_submit")}</SubmitButton>
      </>
    ),
    error,
    session,
    title: t("news.new_title"),
  });

/** The Edit tab's panel: the pre-filled fields form (name, the editable slug
 * with its public link, SEO meta, snippet, markdown body) posting to the update
 * route. */
export const newsEditPanel = (post: NewsPost): JSX.Element => (
  <CsrfForm action={`${LIST}/${post.id}/edit`}>
    <Raw html={newsPostEditForm.renderFields(newsPostToValues(post))} />
    {SaveChangesButton()}
  </CsrfForm>
);

export const adminNewsDeletePage = (
  post: NewsPost,
  session: AdminSession,
  error?: string,
): string =>
  deleteConfirmPage("news", ACTIVE)(
    `${LIST}/${post.id}/delete`,
    post.name,
    session,
    error,
  );
