/**
 * Admin guide — Accounts sections.
 */

import { durationWords } from "#shared/format-units.ts";
import {
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_ATTEMPTS,
  SESSION_MAX_AGE_S,
} from "#shared/limits.ts";
import { WEBHOOK_EXAMPLE_JSON } from "#shared/webhook-example.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
import { PricedJsonExample } from "#templates/admin/guide/integrations.tsx";

/** The lockout length, as the guide states it wherever it describes the block. */
const lockoutLength = (
  <strong>{durationWords(LOGIN_LOCKOUT_MS / 1000)}</strong>
);

export const accountsSections = (): GuideSection[] => [
  {
    entries: [
      faq("owner_vs_manager"),
      faq("editor_role"),
      faq("agent_role"),
      faq("scanner_role"),
      faq("invite_admin"),
      faq("invite_link_expiry"),
    ],
    id: "user-classes",
    titleKey: "users_and_permissions",
  },
  {
    entries: [
      custom(
        "what_happens_if_i_enter_the_wrong",
        <>
          <p>
            After <strong>{MAX_LOGIN_ATTEMPTS} wrong tries</strong> from the
            same place, that place is blocked from logging in for{" "}
            {lockoutLength}. During
            the block, every attempt is refused — even with the right password.
          </p>
          <p>Wait for the block to pass, then try again.</p>
        </>,
      ),
      custom(
        "why_am_i_locked_out_even_though",
        <>
          <p>
            You have probably tripped the safety lock after earlier wrong tries.
            The lock applies to your IP address — roughly, the internet
            connection you are using — not to your account. Other admins
            elsewhere are not affected.
          </p>
          <p>Wait {durationWords(LOGIN_LOCKOUT_MS / 1000)} and try again.</p>
        </>,
      ),
      faq("is_there_a_way_to_recover_a"),
      custom(
        "how_are_admin_sessions_secured",
        <>
          <p>
            Sign-ins use cookies that websites are not allowed to read, so a bad
            page cannot steal one. Each sign-in expires after{" "}
            <strong>{durationWords(SESSION_MAX_AGE_S)}</strong>, then you must
            log in again.
          </p>
          <p>
            You can see every active sign-in, and end all the others, on the{" "}
            <strong>Sessions</strong> page — useful if you think someone else
            has got into your account.
          </p>
        </>,
      ),
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
    id: "data-privacy",
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
            Each message is sent as JSON — a text shape that computer systems
            read easily. This one is for your web builder. Here is an example
            message for a paid listing booking:
          </p>
          <PricedJsonExample json={WEBHOOK_EXAMPLE_JSON}>
            The <code>ticket_url</code> links to the attendee's ticket page. For
            multi-listing bookings the <code>tickets</code> array contains one
            entry per listing, all sharing the same ticket token.
          </PricedJsonExample>
        </>,
      ),
    ],
    id: "webhooks",
    titleKey: "webhooks",
  },
  {
    entries: [
      custom(
        "what_are_sessions",
        <p>
          A session starts each time an admin logs in. Sessions expire after{" "}
          {durationWords(SESSION_MAX_AGE_S)}. You can see every active session
          on the <strong>Sessions</strong> page.
        </p>,
      ),
      faq("what_happens_when_i_change_my_password"),
      faq("how_do_i_log_out_other_users"),
      custom(
        "failed_login_attempts",
        <>
          <p>
            The login form is protected against password guessing. After{" "}
            <strong>{MAX_LOGIN_ATTEMPTS} wrong tries</strong> from the same
            place — the same internet connection, called an IP address — further
            tries from that place are blocked for {lockoutLength}. A
            successful login clears the count straight away.
          </p>
          <p>
            If you are blocked, wait for the block to pass, or log in from a
            different connection — for example your phone's internet. Because
            there is <strong>no password recovery</strong> (see{" "}
            <strong>Data &amp; privacy</strong>), another owner cannot unlock
            the block for you. Only time, or a different connection, clears it.
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
