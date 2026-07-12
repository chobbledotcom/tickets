/**
 * Attendee entity page content: the Overview summary rows,
 * the contact-history panel, the merge form, and the always-visible banner
 * (status heading + notes). The page shape itself — tabs, strip, sections —
 * is the shared entity-pages renderer; this file only supplies the
 * attendee-specific content it composes.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import { targetQuery } from "#shared/bulk-email.ts";
import { formatCurrency } from "#shared/currency.ts";
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
import { dataTable } from "#templates/components/data-table.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import {
  PageBlock,
  PageRegions,
} from "#templates/components/page-structure.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
import { quantityLabel } from "#templates/public/order-summary.tsx";

/** One channel's contact record plus the URL-safe HMAC param that keys its
 * /admin/history editor link. Null when the attendee has no value for that
 * channel. */
export type ContactChannelData = { hashParam: string; record: ContactRecord };

/** Per-channel contact records shown in the read-only history panel. */
export type ContactRecordsByChannel = {
  email: ContactChannelData | null;
  phone: ContactChannelData | null;
};

/** One booked listing on a previous booking (name + how many were taken). */
export type PreviousBookingItem = { name: string; quantity: number };

/** One row of the Previous bookings table: another booking made by the same
 * contact (email or phone), resolved from the contact's encrypted token list. */
export type PreviousBooking = {
  attendeeId: number;
  created: string;
  statusName: string | null;
  items: PreviousBookingItem[];
  totalValue: number;
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

/** Render one channel's outreach detail: the last-contact recap, the
 * markdown-rendered private note, and an Edit link to its history page. The
 * booking and message counts are shown once in the shared summary above, so
 * this panel only carries the per-channel outreach fields. */
const ContactRecordSection = ({
  channel,
  label,
}: {
  channel: ContactChannelData;
  label: string;
}): JSX.Element => {
  const { hashParam, record } = channel;
  return (
    <ProseSection
      footer={
        <>
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
        </>
      }
      headingTag="h4"
      title={label}
    >
      {record.lastContact && (
        <p>
          <strong>{t("attendee_form.last_contacted")}:</strong>{" "}
          {formatDatetimeShort(record.lastContact)}
        </p>
      )}
      {record.lastSubject && (
        <p>
          <strong>{t("attendee_form.last_subject")}:</strong>{" "}
          {record.lastSubject}
        </p>
      )}
    </ProseSection>
  );
};

/** The Previous bookings table: one row per other booking made by this contact,
 * newest first, each row's date linking through to that attendee. */
const PreviousBookingsTable = ({
  bookings,
}: {
  bookings: PreviousBooking[];
}): JSX.Element =>
  dataTable<PreviousBooking>([
    {
      cell: (booking) => (
        <a href={`/admin/attendees/${booking.attendeeId}`}>
          {formatDatetimeShort(booking.created)}
        </a>
      ),
      header: t("attendee_form.col_booking_date"),
    },
    {
      cell: (booking) => booking.statusName ?? t("attendee_form.status_none"),
      header: t("attendee_form.col_status"),
    },
    {
      cell: (booking) =>
        booking.items
          .map((item) => quantityLabel(item.quantity, item.name))
          .join(", "),
      header: t("attendee_form.col_items"),
    },
    {
      cell: (booking) => formatCurrency(booking.totalValue),
      class: "amount",
      header: t("attendee_form.col_value"),
    },
  ])(bookings);

/** The shared summary line count above the tables: total previous bookings plus
 * each channel's message total. */
const ContactSummary = ({
  contactRecords,
  previousBookings,
}: {
  contactRecords: ContactRecordsByChannel;
  previousBookings: PreviousBooking[];
}): JSX.Element => (
  <ul>
    <li>
      <strong>{t("attendee_form.previous_bookings_shown")}:</strong>{" "}
      {previousBookings.length}
    </li>
    {contactRecords.email && (
      <li>
        <strong>{t("attendee_form.total_email_messages")}:</strong>{" "}
        {contactRecords.email.record.contactCount}
      </li>
    )}
    {contactRecords.phone && (
      <li>
        <strong>{t("attendee_form.total_phone_messages")}:</strong>{" "}
        {contactRecords.phone.record.contactCount}
      </li>
    )}
  </ul>
);

/** Render contact history: a shared booking/message summary, the Previous
 * bookings table, and each channel's outreach detail. */
export const ContactHistory = ({
  attendee,
  contactRecords,
  previousBookings,
  isOwner,
}: {
  attendee: Attendee;
  contactRecords: ContactRecordsByChannel;
  previousBookings: PreviousBooking[];
  isOwner: boolean;
}): JSX.Element => {
  const hasEmail = Boolean(attendee.email);
  return (
    <PageRegions>
      <PageBlock>
        <div class="prose">
          <h3>{t("attendee_form.contact_history")}</h3>
          {!contactRecords.email && (
            <p>{t("attendee_form.no_email_on_file")}</p>
          )}
          {!contactRecords.phone && (
            <p>{t("attendee_form.no_phone_on_file")}</p>
          )}
          <ContactSummary
            contactRecords={contactRecords}
            previousBookings={previousBookings}
          />
        </div>
        {previousBookings.length > 0 && (
          <PreviousBookingsTable bookings={previousBookings} />
        )}
      </PageBlock>
      {contactRecords.email && (
        <ContactRecordSection
          channel={contactRecords.email}
          label={t("attendee_form.stats_for", { value: attendee.email })}
        />
      )}
      {contactRecords.phone && (
        <ContactRecordSection
          channel={contactRecords.phone}
          label={t("attendee_form.stats_for", { value: attendee.phone })}
        />
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
    </PageRegions>
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
}): JSX.Element | null => {
  const showStatus = statuses.length > 1;
  if (!showStatus && notes.length === 0) return null;
  const status = statuses.find((s) => s.id === attendee.status_id);
  return (
    <PageBlock className="attendee-banner">
      {showStatus && (
        <div class="prose attendee-status">
          <h2>
            {t("attendee_form.status_heading", {
              value: status ? status.name : t("attendee_form.status_none"),
            })}
          </h2>
        </div>
      )}
      <AttendeeNotesSection notes={notes} />
    </PageBlock>
  );
};
