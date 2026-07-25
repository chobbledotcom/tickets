/**
 * Join (invite) page templates
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { joinForm } from "#routes/join.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { SuccessCompletePage } from "#templates/components/success-complete-page.tsx";
import { simplePublicPage } from "#templates/public/prose-page.tsx";
import { AuthFormPage } from "#templates/setup.tsx";
/* jscpd:ignore-end */

/**
 * Join page - set password for invited user
 */
export const joinPage = (
  code: string,
  username: string,
  error?: string,
): string =>
  AuthFormPage({
    action: `/join/${code}`,
    children: [<button type="submit">{t("join.set_password.submit")}</button>],
    error,
    formHtml: joinForm.render(),
    heading: t("join.set_password.welcome", { username }),
    intro: t("join.set_password.instructions"),
    title: t("join.set_password.title"),
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
  simplePublicPage(
    t("join.invalid.title"),
    t("join.invalid.heading"),
  )(<Flash error={message} />);
