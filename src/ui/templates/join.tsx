/**
 * Join (invite) page templates
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { joinForm } from "#routes/join.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { PageLayout } from "#templates/components/page-layout.tsx";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { Layout } from "#templates/layout.tsx";
import { simplePublicPage } from "#templates/public/shared.tsx";
/* jscpd:ignore-end */

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
      <PageLayout>
        <CsrfForm action={`/join/${code}`}>
          <div class="prose">
            <h1>{t("join.set_password.welcome", { username })}</h1>
            <p>{t("join.set_password.instructions")}</p>
          </div>
          <Flash error={error} />
          <Raw html={joinForm.render()} />
          <button type="submit">{t("join.set_password.submit")}</button>
        </CsrfForm>
      </PageLayout>
    </Layout>,
  );

/**
 * Join complete page - password set and account self-activated, ready to log in
 */
export const joinCompletePage = (): string =>
  SuccessCompletePage({
    heading: t("join.success.heading"),
    loginLink: t("join.success.login_link"),
    messages: [t("join.success.message"), t("join.success.ready")],
    title: t("join.success.title"),
  });

/**
 * Join error page - invalid or expired invite
 */
export const joinErrorPage = (message: string): string =>
  simplePublicPage(
    t("join.invalid.title"),
    t("join.invalid.heading"),
  )(<Flash error={message} />);
