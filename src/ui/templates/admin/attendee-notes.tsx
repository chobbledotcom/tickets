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

/* jscpd:ignore-start */
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
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { formattingHint } from "#templates/fields.ts";

/* jscpd:ignore-end */

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
 * The trailing action row shared by the add and delete note pages: a "Cancel"
 * button back to `returnUrl`, optionally led by a `submit` control (the add
 * page's Save button; the delete page has none — its submit lives elsewhere).
 */
const NoteActions = ({
  returnUrl,
  submit,
}: {
  returnUrl: string;
  submit?: JSX.Element;
}): JSX.Element => (
  <p class="actions">
    {submit}
    <ActionButton href={returnUrl} variant="secondary">
      {t("notes.cancel")}
    </ActionButton>
  </p>
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
 * The notes block on the attendee page: every note (oldest first). Renders
 * nothing when the attendee has no notes, so the page carries no empty
 * `.attendee-notes` section. The "Add a note" link lives beside the page
 * heading (see {@link AddNoteLink}), not here.
 */
export const AttendeeNotesSection = ({
  notes,
}: {
  notes: SystemNote[];
}): JSX.Element | null =>
  notes.length === 0 ? null : (
    <section class="attendee-notes">
      {notes.map((note) => (
        <NoteBox note={note} />
      ))}
    </section>
  );

/**
 * The "Add a note" link shown next to the attendee's page heading. Returns to
 * the attendee page after adding.
 */
export const AddNoteLink = ({
  attendeeId,
}: {
  attendeeId: number;
}): JSX.Element => (
  <p>
    <a
      href={`/admin/attendee/${attendeeId}/note?return_url=${encodeURIComponent(
        attendeeUrl(attendeeId),
      )}`}
    >
      {t("notes.add_link")}
    </a>
  </p>
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
  error?: string | undefined;
}): string =>
  String(
    <AdminPage
      active={{ section: "/admin/attendees" }}
      flash={<Flash error={error} />}
      session={session}
      title={t("notes.add_title")}
    >
      <div class="prose">
        <h1>{t("notes.add_heading", { name: attendeeName })}</h1>
      </div>
      <CsrfForm action={`/admin/attendee/${attendeeId}/note`}>
        <input name="return_url" type="hidden" value={returnUrl} />
        <Raw
          html={renderField({
            hint: t("notes.note_hint"),
            hintHtml: formattingHint(),
            label: t("notes.note_label"),
            markdown: true,
            maxlength: MAX_TEXTAREA_LENGTH,
            name: "note",
            required: true,
            type: "textarea",
          })}
        />
        <NoteActions
          returnUrl={returnUrl}
          submit={<SubmitButton icon="save">{t("notes.save")}</SubmitButton>}
        />
      </CsrfForm>
    </AdminPage>,
  );

/**
 * The are-you-sure delete page. Shows the note being deleted then a plain
 * confirm button (no copy/paste name confirmation), bouncing back to
 * `returnUrl` on confirm or cancel.
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
  error?: string | undefined;
}): string =>
  ConfirmPage({
    action: `/admin/attendee/${note.attendee_id}/note/${note.id}/delete`,
    active: { section: "/admin/attendees" },
    buttonText: t("notes.delete_submit"),
    children: (
      <>
        <h1>{t("notes.delete_title")}</h1>
        <p>{t("notes.delete_confirm")}</p>
        <NoteActions returnUrl={returnUrl} />
      </>
    ),
    confirmName: false,
    error,
    label: "",
    name: "",
    prefix: (
      <div
        class={
          note.type === "system"
            ? "system-note system-note-alert"
            : "system-note"
        }
      >
        <NoteBody note={note} />
      </div>
    ),
    returnUrl,
    session,
    title: t("notes.delete_title"),
  });
