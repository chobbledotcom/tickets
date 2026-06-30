/**
 * Join (invite) page templates
 */

import { t } from "#i18n";
import { joinForm } from "#routes/join.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ActionButton } from "#templates/components/actions.tsx";
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
      <CsrfForm action={`/join/${code}`}>
        <div class="prose">
          <h1>{t("join.set_password.welcome", { username })}</h1>
          <p>{t("join.set_password.instructions")}</p>
        </div>
        <Flash error={error} />
        <Raw html={joinForm.render()} />
        <button type="submit">{t("join.set_password.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Join complete page - password set and account self-activated, ready to log in
 */
export const joinCompletePage = (): string =>
  String(
    <Layout title={t("join.success.title")}>
      <h1>{t("join.success.heading")}</h1>
      <div class="success" role="alert">
        <p>{t("join.success.message")}</p>
        <p>{t("join.success.ready")}</p>
      </div>
      <p class="actions">
        <ActionButton href="/admin/login" icon="log-in">
          {t("join.success.login_link")}
        </ActionButton>
      </p>
    </Layout>,
  );

/**
 * Join error page - invalid or expired invite
 */
export const joinErrorPage = (message: string): string =>
  String(
    <Layout title={t("join.invalid.title")}>
      <h1>{t("join.invalid.heading")}</h1>
      <Flash error={message} />
    </Layout>,
  );
