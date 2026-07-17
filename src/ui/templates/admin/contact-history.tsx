/**
 * Editor for a single contact_preferences record, keyed by its HMAC blind
 * index. Surfaces the raw per-source booking counts, message stats and the
 * owner-encrypted private note so the operator can inspect and repair a
 * contact's aggregated history directly — the hidden DB row made malleable.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ContactRecord } from "#shared/db/contact-preferences.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import { renderField } from "#shared/forms/rendering.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { AdminSession } from "#shared/types.ts";
import { AttendeesPage } from "#templates/admin/attendee-form.tsx";
import { ContactNotes } from "#templates/admin/attendee-page.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

export type ContactHistoryPageData = {
  /** The contact's HMAC blind index (contact_hash), also the route param. */
  hmac: string;
  record: ContactRecord;
  session: AdminSession;
  flashError?: string | undefined;
  flashSuccess?: string | undefined;
  /** Inline validation error from a rejected save (re-rendered in place). */
  formError?: string | null;
};

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

export const contactHistoryPage = ({
  hmac,
  record,
  session,
  flashError,
  flashSuccess,
  formError,
}: ContactHistoryPageData): string =>
  AttendeesPage({
    children: (
      <CsrfForm action={`/admin/history/${hmac}`} id="contact-history-form">
        <Flash error={flashError} success={flashSuccess} />
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
          <button class="btn" type="submit">
            {t("contact_history.save")}
          </button>
        </p>
      </CsrfForm>
    ),
    prose: (
      <>
        <p>{t("contact_history.description")}</p>
        <p class="muted small">
          {t("contact_history.hash_label")}: <code>{hmac}</code>
        </p>
      </>
    ),
    session,
    title: t("contact_history.title"),
  });
