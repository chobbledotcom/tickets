/**
 * Admin templates for Site → News: the newest-first list, the create/edit
 * forms (the edit page carrying the shared images panel), and the delete
 * confirmation.
 */

import { t } from "#i18n";
import { newsPostForm, newsPostToValues } from "#routes/admin/news-form.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, NewsPost, NewsPostCard } from "#shared/types.ts";
import { AdminPage, adminFormPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  ActionButton,
  DeleteSection,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";

const LIST = "/admin/site/news";
const ACTIVE = LIST;

export const adminNewsListPage = (
  posts: NewsPostCard[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <AdminPage active={ACTIVE} session={session} title={t("news.title")}>
      <h1>{t("news.title")}</h1>
      <Flash success={successMessage} />
      <p class="actions">
        <ActionButton href={`${LIST}/new`} icon="plus">
          {t("news.add")}
        </ActionButton>
      </p>
      {posts.length === 0 ? (
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
      )}
    </AdminPage>,
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
      <CsrfForm action={`${LIST}/${post.id}/edit`}>
        <h1>{t("news.edit_title")}</h1>
        <Flash error={error} />
        <Raw html={newsPostForm.renderFields(newsPostToValues(post))} />
        {SaveChangesButton()}
      </CsrfForm>

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
  ConfirmPage({
    action: `${LIST}/${post.id}/delete`,
    active: ACTIVE,
    buttonText: t("news.delete_submit"),
    children: (
      <>
        <h1>{t("news.delete_title")}</h1>
        <p>{t("news.delete_prompt", { name: post.name })}</p>
      </>
    ),
    error,
    label: t("news.name_label"),
    name: post.name,
    session,
    title: t("news.delete_title"),
  });
