/**
 * Editor for a single contact_preferences record, keyed by its HMAC blind
 * index. Surfaces the raw per-source booking counts, message stats and the
 * owner-encrypted private note so the operator can inspect and repair a
 * contact's aggregated history directly — the hidden DB row made malleable.
 */

import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ContactRecord } from "#shared/db/contact-preferences.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type ContactHistoryPageData = {
  /** The contact's HMAC blind index (contact_hash), also the route param. */
  hmac: string;
  record: ContactRecord;
  session: AdminSession;
  flashError?: string;
  flashSuccess?: string;
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
  <label>
    {label}
    <input min="0" name={name} step="1" type="number" value={String(value)} />
  </label>
);

export const contactHistoryPage = ({
  hmac,
  record,
  session,
  flashError,
  flashSuccess,
  formError,
}: ContactHistoryPageData): string =>
  String(
    <Layout title={t("contact_history.title")}>
      <AdminNav active="/admin/attendees" session={session} />

      <div class="prose">
        <h1>{t("contact_history.title")}</h1>
        <p>{t("contact_history.description")}</p>
        <p class="muted small">
          {t("contact_history.hash_label")}: <code>{hmac}</code>
        </p>
      </div>

      <CsrfForm action={`/admin/history/${hmac}`} id="contact-history-form">
        <Flash error={flashError} success={flashSuccess} />
        {formError && (
          <div class="error" role="alert">
            {formError}
          </div>
        )}

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

        <label>
          {t("contact_history.notes_label")}
          <textarea name="admin_notes" rows={6}>
            {record.adminNotes}
          </textarea>
        </label>

        <p class="muted small">
          {t("contact_history.last_contacted_label")}:{" "}
          {record.lastContact
            ? formatDatetimeShort(record.lastContact)
            : t("contact_history.never")}
        </p>

        {record.adminNotes && (
          <section>
            <h2>{t("contact_history.note_preview_label")}</h2>
            <div class="contact-notes">
              <Raw html={renderMarkdown(record.adminNotes)} />
            </div>
          </section>
        )}

        <p>
          <button class="btn" type="submit">
            {t("contact_history.save")}
          </button>
        </p>
      </CsrfForm>
    </Layout>,
  );
