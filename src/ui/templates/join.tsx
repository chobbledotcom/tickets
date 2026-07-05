/**
 * Join (invite) page templates
 */

import { t } from "#i18n";
import { joinForm } from "#routes/join.ts";
import { Flash } from "#shared/forms.tsx";
import { IntroFormPage } from "#templates/components/intro-form-page.tsx";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { Layout } from "#templates/layout.tsx";

/**
 * Join page - set password for invited user
 */
export const joinPage = (
  code: string,
  username: string,
  error?: string,
): string =>
  IntroFormPage({
    action: `/join/${code}`,
    error,
    fieldsHtml: joinForm.render(),
    heading: t("join.set_password.welcome", { username }),
    intro: t("join.set_password.instructions"),
    pageTitle: t("join.set_password.title"),
    submitLabel: t("join.set_password.submit"),
  });

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
  String(
    <Layout title={t("join.invalid.title")}>
      <h1>{t("join.invalid.heading")}</h1>
      <Flash error={message} />
    </Layout>,
  );
