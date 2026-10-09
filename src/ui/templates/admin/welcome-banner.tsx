/**
 * The new-owner welcome message on the dashboard: the first steps, one per
 * line, each a link to its page, until the owner dismisses it.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { ItemList } from "#templates/components/item-list.tsx";

/** One first step: the line's copy key and the page it opens. A step with
 *  `needsSite` opens a public page. The banner shows that step as plain text
 *  while the site feature is off, which is the rule the page itself enforces. */
export type WelcomeStep = {
  readonly href: string;
  readonly labelKey: string;
  readonly needsSite?: true;
};

/** The first steps, in the order a new owner meets them. */
export const WELCOME_STEPS: readonly WelcomeStep[] = [
  {
    href: "/admin/listing/new",
    labelKey: "admin.dashboard.welcome.step_add_listing",
  },
  {
    href: "/listings",
    labelKey: "admin.dashboard.welcome.step_test_booking",
    needsSite: true,
  },
  {
    href: "/admin/listings",
    labelKey: "admin.dashboard.welcome.step_share_link",
  },
  {
    href: "/admin/settings-advanced",
    labelKey: "admin.dashboard.welcome.step_address",
  },
  {
    href: "/admin/modifiers",
    labelKey: "admin.dashboard.welcome.step_modifiers",
  },
];

/** One step line: the label, as a link when its page is open. */
const WelcomeStepLine = ({
  href,
  labelKey,
  needsSite,
}: WelcomeStep): JSX.Element =>
  needsSite && !settings.features.site ? (
    <span>{t(labelKey)}</span>
  ) : (
    <a href={href}>{t(labelKey)}</a>
  );

/** The welcome message: the steps and the "Got it" dismiss button. Both the
 *  button and the banner gate on the owner role, so a viewer never sees a
 *  control its target refuses. */
export const WelcomeBanner = (): JSX.Element => (
  <section class="welcome-banner">
    <h2>{t("admin.dashboard.welcome.heading")}</h2>
    <p>{t("admin.dashboard.welcome.intro")}</p>
    <ItemList items={WELCOME_STEPS} render={WelcomeStepLine} />
    <CsrfForm action="/admin/welcome/dismiss">
      <button class="btn" type="submit">
        {t("admin.dashboard.welcome.dismiss")}
      </button>
    </CsrfForm>
  </section>
);
