/**
 * Admin guide — Email sections.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  custom,
  faq,
  type GuideHostConfig,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
import {
  ANSWERS_LOOP_EXAMPLE,
  LOOP_EXAMPLE,
  TEMPLATE_VARIABLES,
} from "#templates/components/email-template-reference.tsx";
/* jscpd:ignore-end */

export const emailSections = (hostConfig?: GuideHostConfig): GuideSection[] => [
  {
    entries: [
      faq("what_are_email_notifications"),
      faq("supported_email_providers"),
      custom(
        "setup_email",
        <>
          {hostConfig?.hostEmailProvider && (
            <p>
              Email is already set up by the company that runs your site, using{" "}
              <strong>{hostConfig.hostEmailProvider}</strong> and the address{" "}
              <code>{hostConfig.hostEmailFromAddress}</code>. You can use your
              own company instead: enter it in{" "}
              <a href="/admin/settings-advanced#settings-email">
                Advanced Settings
              </a>
              . Your own settings come first.
            </p>
          )}
          <ol>
            <li>
              Sign up with one of the email companies above, if you have not
              already
            </li>
            <li>
              Go to{" "}
              <a href="/admin/settings-advanced#settings-email">
                Advanced Settings
              </a>{" "}
              and find the <strong>Email</strong> section
            </li>
            <li>
              Choose your email company from the dropdown, and paste in your key
            </li>
            <li>
              Enter a <strong>From Address</strong> — the address attendees see
              when they get your emails. Leave it blank to use your business
              email address
            </li>
            <li>Save the settings</li>
          </ol>
          <p>
            Your email company must recognise the from address before it will
            send from it — this stops strangers sending email as you. The
            company's own help pages explain how to add and confirm an address.
          </p>
        </>,
      ),
      faq("test_email_working"),
      faq("email_not_configured"),
      faq("confirmation_email_content"),
      faq("admin_notification_email_content"),
    ],
    id: "email",
    titleKey: "email_notifications",
  },
  {
    entries: [
      faq("customise_emails"),
      custom(
        "template_variables",
        <>
          <ul>
            {TEMPLATE_VARIABLES.map(([code, key]) => (
              <li>
                <code>{code}</code> &mdash;{" "}
                {t(`settings.advanced.email_variables.${key}`)}
              </li>
            ))}
          </ul>
          <p>{t("settings.advanced.email_variables.example_intro")}</p>
          <pre>
            <code>{LOOP_EXAMPLE}</code>
          </pre>
          <p>{t("settings.advanced.email_variables.answers_example_intro")}</p>
          <pre>
            <code>{ANSWERS_LOOP_EXAMPLE}</code>
          </pre>
          <p>{t("settings.advanced.email_variables.not_available")}</p>
        </>,
      ),
      custom(
        "template_filters",
        <>
          <p>Two custom filters are built in:</p>
          <ul>
            <li>
              <code>{"{{ amount | currency }}"}</code> &mdash; formats a number
              as currency (e.g. &pound;15.00)
            </li>
            <li>
              <code>{'{{ count | pluralize: "ticket", "tickets" }}'}</code>{" "}
              &mdash; returns the singular or plural form based on the count
            </li>
          </ul>
        </>,
      ),
      faq("template_error"),
    ],
    id: "email-templates",
    titleKey: "email_templates",
  },
  {
    entries: [
      faq("how_do_i_email_a_group_of"),
      faq("who_can_i_send_to"),
      faq("why_do_i_need_my_own_email"),
      faq("what_s_the_difference_between_a_marketing"),
      faq("how_does_unsubscribing_work"),
      faq("what_is_the_bcc_email_app_option"),
      faq("can_i_see_how_often_i_ve"),
    ],
    id: "bulk-email",
    titleKey: "bulk_email",
  },
];
