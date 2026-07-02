/**
 * Attendee entity page content (edit-pages.md): the Overview summary rows,
 * the contact-history panel, the merge form, and the always-visible banner
 * (status heading + notes). The page shape itself — tabs, strip, sections —
 * is the shared entity-pages renderer; this file only supplies the
 * attendee-specific content it composes.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import { targetQuery } from "#shared/bulk-email.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { ContactRecord } from "#shared/db/contact-preferences.ts";
import type { SystemNote } from "#shared/db/system-notes.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { Attendee } from "#shared/types.ts";
import { AttendeeNotesSection } from "#templates/admin/attendee-notes.tsx";
import type { SummaryRow } from "#templates/admin/entity-pages.tsx";
import { MaybeButtonLink } from "#templates/components/actions.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";

/** One channel's contact record plus the URL-safe HMAC param that keys its
 * /admin/history editor link. Null when the attendee has no value for that
 * channel. */
export type ContactChannelData = { hashParam: string; record: ContactRecord };

/** Per-channel contact records shown in the read-only history panel. */
export type ContactRecordsByChannel = {
  email: ContactChannelData | null;
  phone: ContactChannelData | null;
};

/** Preserve the author's line breaks for multi-line free text. */
const Multiline = ({ text }: { text: string }): JSX.Element => (
  <span style="white-space:pre-wrap">{text}</span>
);

/**
 * The Overview summary rows — the single-attendee key/value table. Optional
 * contact fields are omitted when blank so the table only spells out what's
 * on file, and the ticket row links only when the ticket page is live
 * (a no-quantity-only attendee's /t page 404s, so it gets an indicator, not
 * a dead link).
 */
export const attendeeSummaryRows = ({
  attendee,
  allowedDomain,
  phonePrefix,
  hasRealLine,
}: {
  attendee: Attendee;
  allowedDomain: string;
  phonePrefix: string;
  hasRealLine: boolean;
}): SummaryRow[] =>
  compact([
    { labelKey: "common.name", value: attendee.name },
    attendee.email
      ? {
          href: `mailto:${attendee.email}`,
          labelKey: "common.email",
          value: attendee.email,
        }
      : null,
    attendee.phone
      ? {
          labelKey: "common.phone",
          value: (
            <PhoneLinks phone={attendee.phone} phonePrefix={phonePrefix} />
          ),
        }
      : null,
    attendee.address
      ? {
          labelKey: "common.address",
          value: (
            <>
              <Multiline text={attendee.address} />
              <MapsLinks query={attendee.address} />
            </>
          ),
        }
      : null,
    attendee.special_instructions
      ? {
          labelKey: "common.special_instructions",
          value: <Multiline text={attendee.special_instructions} />,
        }
      : null,
    hasRealLine
      ? {
          href: `https://${allowedDomain}/t/${attendee.ticket_token}`,
          labelKey: "terms.ticket",
          value: attendee.ticket_token,
        }
      : {
          labelKey: "terms.ticket",
          value: (
            <span class="muted small">
              {t("admin.attendee_table.no_quantity")}
            </span>
          ),
        },
    {
      labelKey: "common.registered",
      value: formatDatetimeShort(attendee.created),
    },
  ]);

/** Render one channel's contact record: the per-source booking/message counts,
 * the markdown-rendered private note, and an Edit link to its history page. */
const ContactRecordSection = ({
  channel,
  label,
}: {
  channel: ContactChannelData;
  label: string;
}): JSX.Element => {
  const { hashParam, record } = channel;
  return (
    <section>
      <h4>{label}</h4>
      <ul>
        <li>
          <strong>{t("attendee_form.online_bookings")}:</strong>{" "}
          {record.publicBookingCount}
        </li>
        <li>
          <strong>{t("attendee_form.admin_bookings")}:</strong>{" "}
          {record.adminBookingCount}
        </li>
        <li>
          <strong>{t("attendee_form.total_messages")}:</strong>{" "}
          {record.contactCount}
        </li>
        {record.lastContact && (
          <li>
            <strong>{t("attendee_form.last_contacted")}:</strong>{" "}
            {formatDatetimeShort(record.lastContact)}
          </li>
        )}
        {record.lastSubject && (
          <li>
            <strong>{t("attendee_form.last_subject")}:</strong>{" "}
            {record.lastSubject}
          </li>
        )}
      </ul>
      {record.adminNotes && (
        <div class="contact-notes">
          <Raw html={renderMarkdown(record.adminNotes)} />
        </div>
      )}
      <p>
        <a href={`/admin/history/${hashParam}`}>
          {t("attendee_form.edit_contact_record")}
        </a>
      </p>
    </section>
  );
};

/** Render contact history for each available channel. */
export const ContactHistory = ({
  attendee,
  contactRecords,
  isOwner,
}: {
  attendee: Attendee;
  contactRecords: ContactRecordsByChannel;
  isOwner: boolean;
}): JSX.Element => {
  const hasEmail = Boolean(attendee.email);
  return (
    <article>
      <h3>{t("attendee_form.contact_history")}</h3>
      {contactRecords.email ? (
        <ContactRecordSection
          channel={contactRecords.email}
          label={t("attendee_form.stats_for", { value: attendee.email })}
        />
      ) : (
        <p>{t("attendee_form.no_email_on_file")}</p>
      )}
      {contactRecords.phone ? (
        <ContactRecordSection
          channel={contactRecords.phone}
          label={t("attendee_form.stats_for", { value: attendee.phone })}
        />
      ) : (
        <p>{t("attendee_form.no_phone_on_file")}</p>
      )}
      {isOwner && (
        <p>
          <MaybeButtonLink
            class="btn"
            disabled={!hasEmail}
            href={`/admin/emails${targetQuery({
              kind: "attendee",
              token: attendee.ticket_token,
            })}`}
            {...(hasEmail
              ? {}
              : { title: t("attendee_form.no_email_disabled_title") })}
          >
            {t("attendee_form.send_email_to_attendee")}
          </MaybeButtonLink>
        </p>
      )}
    </article>
  );
};

/**
 * The always-visible banner above the tab strip: the attendee's status (only
 * when more than one status exists) and the notes block — system alerts must
 * not hide behind a tab, and the add/delete note links work from any tab.
 */
export const attendeeBanner = ({
  attendee,
  statuses,
  notes,
}: {
  attendee: Attendee;
  statuses: AttendeeStatus[];
  notes: SystemNote[];
}): JSX.Element => {
  const status = statuses.find((s) => s.id === attendee.status_id);
  return (
    <>
      {statuses.length > 1 && (
        <div class="prose">
          <h2>
            {t("attendee_form.status_heading", {
              value: status ? status.name : t("attendee_form.status_none"),
            })}
          </h2>
        </div>
      )}
      <AttendeeNotesSection attendeeId={attendee.id} notes={notes} />
    </>
  );
};
