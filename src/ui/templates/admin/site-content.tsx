/**
 * Shared template blocks for the Site tab's content editors (Pages, News):
 * the list-page opener and the pre-filled edit form.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Flash } from "#shared/forms/flash.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import {
  type RenderedFieldsSaveForm,
  renderedFieldsSaveForm,
} from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

/** Curried list page for a Site-tab collection at `base`: the AdminPage shell
 * with its success flash and Add button (the page's own flash + actions row),
 * with the caller supplying just the collection body. `messages` is the i18n
 * prefix carrying `.title` and `.add`. The page title lives on the browser tab
 * and the nav, so the body carries no redundant `<h1>`. */
export const collectionPage =
  (messages: string, base: string) =>
  (
    session: AdminSession,
    successMessage: string | undefined,
    body: Child,
  ): string =>
    String(
      <AdminPage
        actions={
          <WritableOnly>
            <ActionButton href={`${base}/new`} icon="plus">
              {t(`${messages}.add`)}
            </ActionButton>
          </WritableOnly>
        }
        active={base}
        flash={<Flash success={successMessage} />}
        session={session}
        title={t(`${messages}.title`)}
      >
        {body}
      </AdminPage>,
    );

/** The Edit-tab panel for a Site content editor (Pages, News): a CsrfForm
 * carrying the pre-filled fields and a save button. It draws no heading of its
 * own — the tabbed entity page puts the page title above the tab strip. */
export const contentEditPanel: RenderedFieldsSaveForm = renderedFieldsSaveForm(
  t("common.save_changes"),
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
