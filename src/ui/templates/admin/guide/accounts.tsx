/**
 * Admin guide — Accounts sections.
 */

import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { WEBHOOK_EXAMPLE_JSON } from "#shared/webhook-example.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const accountsSections = (): GuideSection[] => [
  {
    entries: [
      faq("owner_vs_manager"),
      faq("editor_role"),
      faq("agent_role"),
      faq("invite_admin"),
      faq("invite_link_expiry"),
    ],
    id: "user-classes",
    titleKey: "users_and_permissions",
  },
  {
    entries: [
      faq("what_happens_if_i_enter_the_wrong"),
      faq("why_am_i_locked_out_even_though"),
      faq("is_there_a_way_to_recover_a"),
      faq("how_are_admin_sessions_secured"),
    ],
    id: "login-security",
    titleKey: "login_security",
  },
  {
    entries: [
      faq("attendee_data_protection"),
      faq("encryption_overview"),
      faq("privacy_first_by_default"),
      faq("lost_password"),
      faq("export_attendee_data"),
      faq("reset_database"),
    ],
    titleKey: "data_and_privacy",
  },
  {
    entries: [
      faq("what_are_webhooks"),
      faq("setup_webhook"),
      custom(
        "webhook_json_format",
        <>
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
        </>,
      ),
    ],
    id: "webhooks",
    titleKey: "webhooks",
  },
  {
    entries: [
      faq("what_are_sessions"),
      faq("what_happens_when_i_change_my_password"),
      faq("how_do_i_log_out_other_users"),
      custom(
        "failed_login_attempts",
        <>
          <p>
            The login form is protected by per-IP rate limiting. After{" "}
            <strong>{MAX_LOGIN_ATTEMPTS} failed attempts</strong> from the same
            IP address, further login attempts from that IP are blocked for{" "}
            <strong>{LOGIN_LOCKOUT_MS / 60_000} minutes</strong>. A successful
            login clears the counter immediately. This defends against password
            guessing and credential stuffing.
          </p>
          <p>
            If you&apos;re legitimately locked out, wait for the lockout to
            expire or log in from a different network. Because there is{" "}
            <strong>no password recovery</strong> (see{" "}
            <strong>Data & Privacy</strong>), another owner cannot unlock your
            account &mdash; only time (or switching IP) will clear the block.
          </p>
        </>,
      ),
    ],
    id: "login",
    titleKey: "login_sessions",
  },
  {
    entries: [faq("what_is_calendar")],
    id: "calendar",
    titleKey: "calendar",
  },
  {
    entries: [faq("what_is_activity_log")],
    id: "activity-log",
    titleKey: "activity_log",
  },
];
