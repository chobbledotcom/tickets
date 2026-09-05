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
              Email is already configured by your server administrator using{" "}
              <strong>{hostConfig.hostEmailProvider}</strong> with from address{" "}
              <code>{hostConfig.hostEmailFromAddress}</code>. You can override
              this by entering your own provider and API key in{" "}
              <a href="/admin/settings-advanced#settings-email">
                Advanced Settings
              </a>
              . If you provide your own settings, they take priority over the
              server configuration.
            </p>
          )}
          <ol>
            <li>
              Go to{" "}
              <a href="/admin/settings-advanced#settings-email">
                Advanced Settings
              </a>{" "}
              and find the <strong>Email</strong> section
            </li>
            <li>Choose your email provider from the dropdown</li>
            <li>
              Paste your provider's API key into the <strong>API Key</strong>{" "}
              field
            </li>
            <li>
              Enter a <strong>From Address</strong> &mdash; this is the sender
              address that appears on outgoing emails. If left blank, the
              business email address is used instead
            </li>
            <li>Save the settings</li>
          </ol>
          <p>
            The from address must be a verified sender in your email provider's
            account, otherwise emails will be rejected. Check your provider's
            documentation for how to verify a sender domain or address.
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
