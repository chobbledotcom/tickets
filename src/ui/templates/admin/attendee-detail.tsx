/**
 * Read-only attendee views shown at the top of the edit attendee page.
 *
 * `AttendeeDetail` is the single-attendee counterpart to the multi-attendee
 * `AttendeeTable`: instead of one row per attendee it lays a single attendee's
 * details out vertically as a key/value table. `AttendeeAnswersTable` renders
 * the attendee's custom-question answers, and `AttendeeLogSection` wraps the
 * shared activity-log table (filtered to this attendee) in a collapsed
 * details/summary disclosure.
 */

import { compact } from "#fp";
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { phoneLinks } from "#shared/phone.ts";
import type { Attendee } from "#shared/types.ts";
import { ActivityLogTable } from "#templates/admin/activityLog.tsx";

/** One key/value row of a detail table. */
const DetailTableRow = ({
  label,
  children,
}: {
  label: string;
  children: Child;
}): JSX.Element => (
  <tr>
    <th scope="row">{label}</th>
    <td>{children}</td>
  </tr>
);

/** Preserve the author's line breaks for multi-line free text. */
const Multiline = ({ text }: { text: string }): JSX.Element => (
  <span style="white-space:pre-wrap">{text}</span>
);

/** The phone number followed by small `tel:` and WhatsApp links. The number is
 * normalised (e.g. `07700 900000` → `+447700900000`) for the link hrefs while
 * the display keeps whatever the attendee entered. */
const PhoneCell = ({
  phone,
  phonePrefix,
}: {
  phone: string;
  phonePrefix: string;
}): JSX.Element => {
  const links = phoneLinks(phone, phonePrefix);
  return (
    <>
      {phone}
      {links && (
        <>
          {" "}
          <small>
            <a href={links.tel}>{t("attendee_detail.tel")}</a>{" "}
            <a href={links.whatsapp} rel="noopener" target="_blank">
              {t("attendee_detail.whatsapp")}
            </a>
          </small>
        </>
      )}
    </>
  );
};

/**
 * The main read-only details table for a single attendee. Optional contact
 * fields are omitted when blank so the table only spells out what's on file.
 */
export const AttendeeDetail = ({
  attendee,
  allowedDomain,
  phonePrefix,
}: {
  attendee: Attendee;
  allowedDomain: string;
  phonePrefix: string;
}): JSX.Element => {
  const rows = compact([
    <DetailTableRow label={t("attendee_detail.name")}>
      {attendee.name}
    </DetailTableRow>,
    attendee.email ? (
      <DetailTableRow label={t("attendee_detail.email")}>
        <a href={`mailto:${attendee.email}`}>{attendee.email}</a>
      </DetailTableRow>
    ) : null,
    attendee.phone ? (
      <DetailTableRow label={t("attendee_detail.phone")}>
        <PhoneCell phone={attendee.phone} phonePrefix={phonePrefix} />
      </DetailTableRow>
    ) : null,
    attendee.address ? (
      <DetailTableRow label={t("attendee_detail.address")}>
        <Multiline text={attendee.address} />
      </DetailTableRow>
    ) : null,
    attendee.special_instructions ? (
      <DetailTableRow label={t("attendee_detail.special_instructions")}>
        <Multiline text={attendee.special_instructions} />
      </DetailTableRow>
    ) : null,
    <DetailTableRow label={t("terms.ticket")}>
      <a href={`https://${allowedDomain}/t/${attendee.ticket_token}`}>
        {attendee.ticket_token}
      </a>
    </DetailTableRow>,
    <DetailTableRow label={t("attendee_detail.registered")}>
      {formatDatetimeShort(attendee.created)}
    </DetailTableRow>,
  ]);
  return (
    <div class="table-scroll">
      <table class="listing-details-table">
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
};

/**
 * The attendee's answers to custom questions, one row per answered question.
 * Returns null when the attendee has answered nothing, so the caller can drop
 * the section entirely.
 */
export const AttendeeAnswersTable = ({
  questions,
  selectedAnswerIds,
}: {
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
}): JSX.Element | null => {
  const selected = new Set(selectedAnswerIds);
  const answered = compact(
    questions.map((q) => {
      const picks = q.answers.filter((a) => selected.has(a.id));
      return picks.length > 0
        ? { answer: picks.map((a) => a.text).join(", "), question: q.text }
        : null;
    }),
  );
  if (answered.length === 0) return null;
  return (
    <>
      <h3>{t("attendee_detail.answers")}</h3>
      <div class="table-scroll">
        <table class="listing-details-table">
          <tbody>
            {answered.map((row) => (
              <DetailTableRow label={row.question}>{row.answer}</DetailTableRow>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

/**
 * The attendee's activity log, collapsed by default. Renders the same
 * Time/Activity table the /admin/log pages use, filtered to this attendee.
 */
export const AttendeeLogSection = ({
  entries,
}: {
  entries: ActivityLogEntry[];
}): JSX.Element => (
  <details>
    <summary>{t("attendee_detail.activity_log")}</summary>
    <ActivityLogTable entries={entries} />
  </details>
);
