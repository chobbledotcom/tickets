/**
 * Admin guide — Accounts sections.
 */

import { t } from "#i18n";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { WEBHOOK_EXAMPLE_JSON } from "#shared/webhook-example.ts";
import { Faq, Q, Section } from "#templates/admin/guide/components.tsx";

export const Accounts = (): JSX.Element => (
  <>
    <Section
      id="user-classes"
      title={t("guide.sections.users_and_permissions")}
    >
      <Faq id="owner_vs_manager" />

      <Faq id="invite_admin" />

      <Faq id="invite_link_expiry" />
    </Section>

    <Section id="login-security" title="Login &amp; Security">
      <Faq id="what_happens_if_i_enter_the_wrong" />

      <Faq id="why_am_i_locked_out_even_though" />

      <Faq id="is_there_a_way_to_recover_a" />

      <Faq id="how_are_admin_sessions_secured" />
    </Section>

    <Section title={t("guide.sections.data_and_privacy")}>
      <Faq id="attendee_data_protection" />

      <Faq id="lost_password" />

      <Faq id="export_attendee_data" />

      <Faq id="reset_database" />
    </Section>

    <Section id="webhooks" title={t("guide.sections.webhooks")}>
      <Faq id="what_are_webhooks" />

      <Faq id="setup_webhook" />

      <Q q={t("guide.q.webhook_json_format")}>
        <p>
          Each webhook is an HTTP POST with{" "}
          <code>Content-Type: application/json</code>. Here is an example
          payload for a paid listing booking:
        </p>
        <pre>
          <code>{WEBHOOK_EXAMPLE_JSON}</code>
        </pre>
        <p>
          Prices are in the smallest currency unit (e.g. pence for GBP, cents
          for USD). The <code>ticket_url</code> links to the attendee's ticket
          page. For multi-listing bookings the <code>tickets</code> array
          contains one entry per listing, all sharing the same ticket token.
        </p>
      </Q>
    </Section>

    <Section id="login" title="Login &amp; Sessions">
      <Faq id="what_are_sessions" />

      <Faq id="what_happens_when_i_change_my_password" />

      <Faq id="how_do_i_log_out_other_users" />

      <Q q="What happens after too many failed login attempts?">
        <p>
          The login form is protected by per-IP rate limiting. After{" "}
          <strong>{MAX_LOGIN_ATTEMPTS} failed attempts</strong> from the same IP
          address, further login attempts from that IP are blocked for{" "}
          <strong>{LOGIN_LOCKOUT_MS / 60_000} minutes</strong>. A successful
          login clears the counter immediately. This defends against password
          guessing and credential stuffing.
        </p>
        <p>
          If you&apos;re legitimately locked out, wait for the lockout to expire
          or log in from a different network. Because there is{" "}
          <strong>no password recovery</strong> (see{" "}
          <strong>Data &amp; Privacy</strong>), another owner cannot unlock your
          account &mdash; only time (or switching IP) will clear the block.
        </p>
      </Q>
    </Section>

    <Section id="calendar" title={t("guide.sections.calendar")}>
      <Faq id="what_is_calendar" />
    </Section>

    <Section id="activity-log" title={t("guide.sections.activity_log")}>
      <Faq id="what_is_activity_log" />
    </Section>
  </>
);
