/**
 * Shared template blocks for the Site tab's content editors (Pages, News):
 * the list-page opener and the pre-filled edit form.
 */

import { t } from "#i18n";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import type { SubmittedValueProps } from "#shared/form-data.ts";
import { editPanel } from "#templates/admin/admin-page.tsx";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  ActionButton,
  GuideFooter,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  type RenderedFieldsSaveForm,
  renderedFieldsSaveForm,
} from "#templates/components/save-form.tsx";
import type { AdminLevel, AdminSession } from "#types";

/** Curried list page for a Site-tab collection at `base`. It wraps the
 * AdminPage shell with its success flash and Add button (the page's own flash
 * + actions row), and the caller supplies just the collection body. `messages`
 * is the i18n prefix carrying `.title` and `.add`. The page title lives on the
 * browser tab and the nav, so the body carries no redundant `<h1>`. */
export const collectionPage =
  (messages: string, base: string) =>
  (
    session: AdminSession,
    successMessage: string | undefined,
    body: Child,
  ): string =>
    renderAdminPageSpec({
      actions: (
        <WritableOnly>
          <ActionButton href={`${base}/new`} icon="plus">
            {t(`${messages}.add`)}
          </ActionButton>
        </WritableOnly>
      ),
      active: base,
      body,
      flash: { success: successMessage },
      session,
      title: t(`${messages}.title`),
    });

/** The "add one" page of a Site-tab collection: the collection's fields form
 * and its create button, on the collection's declared list path. `messages`
 * is the i18n prefix carrying `.new_title` and `.create_submit`. */
export const contentNewPage =
  (
    base: string,
    messages: string,
    form: { render: () => string },
  ): ((session: AdminSession, error?: string) => string) =>
  (session, error) =>
    renderAdminPageSpec({
      active: base,
      form: {
        action: base,
        fields: (
          <>
            <Raw html={form.render()} />
            <SubmitButton icon="plus">
              {t(`${messages}.create_submit`)}
            </SubmitButton>
          </>
        ),
        flash: { error },
      },
      session,
      title: t(`${messages}.new_title`),
    });

/** The Edit-tab panel for a Site content editor (Pages, News): a CsrfForm
 * carrying the pre-filled fields and a save button. It draws no heading of its
 * own — the tabbed entity page puts the page title above the tab strip. */
export const contentEditPanel: RenderedFieldsSaveForm = renderedFieldsSaveForm(
  t("common.save_changes"),
);

/** The Edit-tab panel for one Site content entity (Pages, News). The form
 * posts to the update route of the entity under the list path of the section.
 * It shows the stored values, or the submitted values of a rejected edit
 * under the message. */
export const contentEntityEditPanel =
  <E extends { id: number }, Values>(
    listPath: string,
    editForm: { render: (values: Values | Record<string, string>) => string },
    valuesOf: (entity: E) => Values,
  ) =>
  (entity: E, submitted: SubmittedValueProps = {}): JSX.Element =>
    editPanel(submitted.error)(
      contentEditPanel(
        `${listPath}/${entity.id}/edit`,
        editForm.render(submitted.values ?? valuesOf(entity)),
      ),
    );

/** The "Guide: …" help link for a Site content page, rendered as a
 * `GuideFooter` at the bottom of the body (matching every other admin page)
 * and jumping to the given guide section anchor. The site editors are
 * owner+editor but `/admin/guide` is staff-only, so it's role-gated — editors
 * see no footer rather than a link that 403s. */
export const contentGuideFooter = (
  anchor: string,
  adminLevel: AdminLevel,
): JSX.Element => (
  <GuideFooter adminLevel={adminLevel} href={`/admin/guide#${anchor}`}>
    <Raw html={t("common.guide_website_content")} />
  </GuideFooter>
);
