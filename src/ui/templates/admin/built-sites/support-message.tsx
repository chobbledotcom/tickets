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
import type { SupportMessageResult } from "#shared/site-support-message.ts";
import {
  SiteActionForm,
  TabErrorNote,
} from "#templates/admin/built-sites/panels.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { textareaBody } from "#templates/components/textarea.tsx";

export const SupportMessagePanel = ({
  site,
  state,
}: {
  site: BuiltSite;
  state: SupportMessageResult;
}): JSX.Element => {
  // A refused save's draft survives here even when the follow-up read also
  // fails: the read error shows above the editor instead of in its place,
  // so the operator keeps their text to retry with.
  const draft = savedFormValueOrNull("support_message");
  const readFailed = !state.ok;
  if (readFailed && draft === null) {
    return (
      <TabErrorNote>
        {t("built_sites.support_message_error", { error: state.error })}
      </TabErrorNote>
    );
  }
  const stored = state.ok ? state.value : null;
  const editorText = draft ?? stored;
  return (
    <div class="prose">
      {readFailed ? (
        <ErrorNote>
          {t("built_sites.support_message_error", { error: state.error })}
        </ErrorNote>
      ) : (
        <p>{t("built_sites.support_message_intro")}</p>
      )}
      <WritableOnly>
        <SiteActionForm action="support-message" siteId={site.id}>
          <label>
            {t("built_sites.support_message_label")}
            <textarea data-markdown-preview name="support_message">
              {textareaBody(editorText ?? "")}
            </textarea>
          </label>
          <p class="hint">{t("built_sites.support_message_limit")}</p>
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
