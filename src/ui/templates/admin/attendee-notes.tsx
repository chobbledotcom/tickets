/**
 * Templates for per-attendee operator notes (the `system_notes` feature).
 *
 *  - {@link AttendeeNotesSection} — the boxes shown on the attendee edit page,
 *    each with a "×" that opens the are-you-sure delete page, plus an add link.
 *  - {@link AttendeeNotesSummary} — the red expandable shown above an attendee
 *    list when any listed attendee has notes.
 *  - {@link adminAddNotePage} — the operator add-note form.
 *  - {@link adminDeleteNotePage} — the are-you-sure delete page (NOT the
 *    copy/paste confirmation), returning to wherever the operator came from.
 */

import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import {
  groupNotesByAttendee,
  type SystemNote,
} from "#shared/db/system-notes.ts";
import { CsrfForm, Flash, renderField } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** The attendee edit page — where the note controls return after an action. */
const attendeeUrl = (attendeeId: number): string =>
  `/admin/attendees/${attendeeId}`;

/** The are-you-sure delete page for one note, returning to `returnUrl`. */
const deleteNoteUrl = (note: SystemNote, returnUrl: string): string =>
  `/admin/attendee/${note.attendee_id}/note/${note.id}/delete?return_url=${encodeURIComponent(
    returnUrl,
  )}`;

/** Render a note's body as (safe) markdown — links and emphasis, HTML escaped. */
const NoteBody = ({ note }: { note: SystemNote }): JSX.Element => (
  <Raw html={renderMarkdown(note.note)} />
);

/**
 * One note as a box: a red alert for a `system` note (so a refunded-but-stored
 * booking can't be missed), a neutral box for an `owner` note. The "×" opens the
 * delete confirmation, returning to the attendee page.
 */
const NoteBox = ({ note }: { note: SystemNote }): JSX.Element => {
  const isSystem = note.type === "system";
  return (
    <div
      class={isSystem ? "system-note system-note-alert" : "system-note"}
      role={isSystem ? "alert" : undefined}
    >
      <a
        aria-label={t("notes.delete")}
        class="system-note-dismiss"
        href={deleteNoteUrl(note, attendeeUrl(note.attendee_id))}
        title={t("notes.delete")}
      >
        ×
      </a>
      {isSystem && (
        <span class="system-note-tag">{t("notes.system_label")}</span>
      )}
      <NoteBody note={note} />
      <p class="muted small">{formatDatetimeShort(note.created)}</p>
    </div>
  );
};

/**
 * The notes block on the attendee edit page: every note (oldest first) plus a
 * link to the add-note page. Returns to the attendee page after adding.
 */
export const AttendeeNotesSection = ({
  attendeeId,
  notes,
}: {
  attendeeId: number;
  notes: SystemNote[];
}): JSX.Element => (
  <section class="attendee-notes">
    {notes.map((note) => (
      <NoteBox note={note} />
    ))}
    <p>
      <a
        href={`/admin/attendee/${attendeeId}/note?return_url=${encodeURIComponent(
          attendeeUrl(attendeeId),
        )}`}
      >
        {t("notes.add_link")}
      </a>
    </p>
  </section>
);

/**
 * A red expandable shown above an attendee list when any listed attendee has
 * notes: each attendee (linked) and their notes, in order. Read-only — managing
 * a note happens from its attendee page. Renders nothing when there are none.
 */
export const AttendeeNotesSummary = ({
  notes,
  names,
}: {
  notes: SystemNote[];
  names: Map<number, string>;
}): JSX.Element | null => {
  if (notes.length === 0) return null;
  const grouped = groupNotesByAttendee(notes);
  return (
    <details class="system-note-alert attendee-notes-summary">
      <summary>{t("notes.summary", { count: grouped.size })}</summary>
      {[...grouped].map(([attendeeId, attendeeNotes]) => (
        <div class="attendee-notes-summary-group">
          <strong>
            <a href={attendeeUrl(attendeeId)}>
              {names.get(attendeeId) ?? `#${attendeeId}`}
            </a>
          </strong>
          {attendeeNotes.map((note) => (
            <div class="system-note">
              <NoteBody note={note} />
            </div>
          ))}
        </div>
      ))}
    </details>
  );
};

/** The operator add-note page. */
export const adminAddNotePage = ({
  attendeeId,
  attendeeName,
  session,
  returnUrl,
  error,
}: {
  attendeeId: number;
  attendeeName: string;
  session: AdminSession;
  returnUrl: string;
  error?: string;
}): string =>
  String(
    <Layout title={t("notes.add_title")}>
      <AdminNav active="/admin/attendees" session={session} />
      <div class="prose">
        <h1>{t("notes.add_heading", { name: attendeeName })}</h1>
      </div>
      <CsrfForm action={`/admin/attendee/${attendeeId}/note`}>
        <Flash error={error} />
        <input name="return_url" type="hidden" value={returnUrl} />
        <Raw
          html={renderField({
            hint: t("notes.note_hint"),
            hintHtml: FORMATTING_HINT,
            label: t("notes.note_label"),
            markdown: true,
            maxlength: MAX_TEXTAREA_LENGTH,
            name: "note",
            required: true,
            type: "textarea",
          })}
        />
        <p>
          <button class="btn" type="submit">
            {t("notes.save")}
          </button>
          <a class="btn btn-secondary" href={returnUrl}>
            {t("notes.cancel")}
          </a>
        </p>
      </CsrfForm>
    </Layout>,
  );

/**
 * The are-you-sure delete page. Shows the note being deleted (no copy/paste
 * confirmation) and bounces back to `returnUrl` on confirm or cancel.
 */
export const adminDeleteNotePage = ({
  note,
  session,
  returnUrl,
  error,
}: {
  note: SystemNote;
  session: AdminSession;
  returnUrl: string;
  error?: string;
}): string =>
  String(
    <Layout title={t("notes.delete_title")}>
      <AdminNav active="/admin/attendees" session={session} />
      <div class="prose">
        <h1>{t("notes.delete_title")}</h1>
        <p>{t("notes.delete_confirm")}</p>
      </div>
      <div
        class={
          note.type === "system"
            ? "system-note system-note-alert"
            : "system-note"
        }
      >
        <NoteBody note={note} />
      </div>
      <CsrfForm
        action={`/admin/attendee/${note.attendee_id}/note/${note.id}/delete`}
      >
        <Flash error={error} />
        <input name="return_url" type="hidden" value={returnUrl} />
        <p>
          <button class="btn btn-danger" type="submit">
            {t("notes.delete_submit")}
          </button>
          <a class="btn btn-secondary" href={returnUrl}>
            {t("notes.cancel")}
          </a>
        </p>
      </CsrfForm>
    </Layout>,
  );
