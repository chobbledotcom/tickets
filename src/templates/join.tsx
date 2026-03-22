/**
 * Join (invite) page templates
 */

import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { t } from "#i18n";
import { joinFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Join page - set password for invited user
 */
export const joinPage = (
  code: string,
  username: string,
  error?: string,
): string =>
  String(
    <Layout title={t("join.set_password.title")}>
      <h1>{t("join.set_password.welcome", { username })}</h1>
      <p>{t("join.set_password.instructions")}</p>
      <Raw html={renderError(error)} />
      <CsrfForm action={`/join/${code}`}>
        <Raw html={renderFields(joinFields)} />
        <button type="submit">{t("join.set_password.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Join complete page - password set, waiting for activation
 */
export const joinCompletePage = (): string =>
  String(
    <Layout title={t("join.success.title")}>
      <h1>{t("join.success.heading")}</h1>
      <div class="success">
        <p>{t("join.success.message")}</p>
        <p>
          {t("join.success.wait_activation")}
        </p>
      </div>
    </Layout>,
  );

/**
 * Join error page - invalid or expired invite
 */
export const joinErrorPage = (message: string): string =>
  String(
    <Layout title={t("join.invalid.title")}>
      <h1>{t("join.invalid.heading")}</h1>
      <div class="error">{message}</div>
    </Layout>,
  );
