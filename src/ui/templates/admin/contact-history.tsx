/**
 * The contact-record editor's form panel, rendered inside the entity-page
 * frame at /admin/history/:hmac. Surfaces the raw per-source booking counts,
 * message stats and the owner-encrypted private note so the operator can
 * inspect and repair a contact's aggregated history directly — the hidden DB
 * row made malleable.
 */

import type { ContactRecord } from "#db/contact-preferences.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { renderField } from "#shared/forms/rendering.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ContactNotes } from "#templates/admin/attendee-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { TextField } from "#templates/components/text-field.tsx";

/* jscpd:ignore-end */

/** A labelled non-negative integer field for one of the plaintext counters. */
const CountField = ({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: number;
}): JSX.Element => (
  <TextField
    label={label}
    min="0"
    name={name}
    step="1"
    type="number"
    value={String(value)}
  />
);

/** The prose beside the heading: what the editor is for, and which contact. */
export const ContactHistoryProse = ({
  hmac,
}: {
  hmac: string;
}): JSX.Element => (
  <>
    <p>{t("contact_history.description")}</p>
    <p class="muted small">
      {t("contact_history.hash_label")}: <code>{hmac}</code>
    </p>
  </>
);

/** The editor form for one contact record. `formError` carries an inline
 * validation error from a rejected save (re-rendered in place). */
export const ContactHistoryForm = ({
  hmac,
  record,
  formError,
}: {
  /** The contact's HMAC blind index (contact_hash), also the route param. */
  hmac: string;
  record: ContactRecord;
  /** Inline validation error from a rejected save (re-rendered in place). */
  formError?: string | null;
}): JSX.Element => (
  <CsrfForm action={`/admin/history/${hmac}`} id="contact-history-form">
    {formError && <ErrorAlert>{formError}</ErrorAlert>}

    <CountField
      label={t("contact_history.visits_label")}
      name="visits"
      value={record.visits}
    />
    <CountField
      label={t("contact_history.public_bookings_label")}
      name="public_booking_count"
      value={record.publicBookingCount}
    />
    <CountField
      label={t("contact_history.admin_bookings_label")}
      name="admin_booking_count"
      value={record.adminBookingCount}
    />
    <CountField
      label={t("contact_history.messages_label")}
      name="messages"
      value={record.contactCount}
    />

    <label>
      {t("contact_history.last_subject_label")}
      <input name="last_subject" type="text" value={record.lastSubject} />
    </label>

    <Raw
      html={renderField(
        {
          hintHtml: formattingHint(),
          label: t("contact_history.notes_label"),
          markdown: true,
          maxlength: MAX_TEXTAREA_LENGTH,
          name: "admin_notes",
          type: "textarea",
        },
        record.adminNotes,
      )}
    />

    <p class="muted small">
      {t("contact_history.last_contacted_label")}:{" "}
      {record.lastContact
        ? formatDatetimeShort(record.lastContact)
        : t("contact_history.never")}
    </p>

    {record.adminNotes && (
      <section>
        <h2>{t("contact_history.note_preview_label")}</h2>
        <ContactNotes notes={record.adminNotes} />
      </section>
    )}

    <p>
      <SubmitButton icon="save">{t("contact_history.save")}</SubmitButton>
    </p>
  </CsrfForm>
);
