/**
 * The built-site Support message tab: the site's current text as its hosting
 * provider stores it, and the markdown editor that saves it back per site.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { isReadOnly } from "#shared/env.ts";
import { savedFormValueOrNull } from "#shared/forms/saved-data.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import {
  SUPPORT_MESSAGE_MAX_BYTES,
  type SupportMessageResult,
} from "#shared/site-support-message.ts";
import {
  SiteActionForm,
  TabErrorNote,
} from "#templates/admin/built-sites/panels.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const SupportMessagePanel = ({
  site,
  state,
}: {
  site: BuiltSite;
  state: SupportMessageResult;
}): JSX.Element => {
  if (!state.ok) {
    return (
      <TabErrorNote>
        {t("built_sites.support_message_error", { error: state.error })}
      </TabErrorNote>
    );
  }
  // A refused save re-fills the editor with the operator's submitted text,
  // so a transient provider failure never costs them the draft.
  const editorText = savedFormValueOrNull("support_message") ?? state.value;
  return (
    <div class="prose">
      <p>{t("built_sites.support_message_intro")}</p>
      <WritableOnly>
        <SiteActionForm action="support-message" siteId={site.id}>
          <label>
            {t("built_sites.support_message_label")}
            <textarea
              data-markdown-preview
              maxlength={SUPPORT_MESSAGE_MAX_BYTES}
              name="support_message"
            >
              {editorText ?? ""}
            </textarea>
          </label>
          <SubmitButton icon="save">
            {t("built_sites.support_message_save")}
          </SubmitButton>
        </SiteActionForm>
      </WritableOnly>
      {isReadOnly() && editorText !== null ? (
        <Raw html={renderMarkdown(editorText)} />
      ) : null}
    </div>
  );
};
