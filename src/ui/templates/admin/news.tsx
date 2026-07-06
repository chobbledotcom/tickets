/**
 * Admin templates for Site → News: the newest-first list, the create/edit
 * forms (the edit page carrying the shared images panel), and the delete
 * confirmation.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { newsPostForm, newsPostToValues } from "#routes/admin/news-form.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, NewsPost, NewsPostSummary } from "#shared/types.ts";
import { AdminPage, adminFormPage } from "#templates/admin/admin-page.tsx";
import {
  collectionPage,
  deleteConfirmPage,
  EditForm,
} from "#templates/admin/site-content.tsx";
import { DeleteSection, SubmitButton } from "#templates/components/actions.tsx";
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

export const adminNewsEditPage = (
  post: NewsPost,
  imagesPanel: JSX.Element,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <AdminPage active={ACTIVE} session={session} title={t("news.edit_title")}>
      <EditForm
        action={`${LIST}/${post.id}/edit`}
        error={error}
        fieldsHtml={newsPostForm.renderFields(newsPostToValues(post))}
        title={t("news.edit_title")}
      />

      <p class="prose">
        {t("news.permalink_label")}: <code>/news/{post.slug}</code>
      </p>

      <h2>{t("news.images_heading")}</h2>
      {imagesPanel}

      <DeleteSection
        heading={t("common.delete")}
        href={`${LIST}/${post.id}/delete`}
      >
        {t("news.delete_submit")}
      </DeleteSection>
    </AdminPage>,
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
