/**
 * Templates for per-attendee operator notes (the `system_notes` feature).
 *
 *  - {@link AttendeeNotesSection} — the boxes shown on the attendee edit page,
 *    each with a "×" that opens the are-you-sure delete page, plus an add link.
 *  - {@link AttendeeNotesSummary} — the red expandable shown above an attendee
 *    list when any listed attendee has notes.
 *  - {@link adminNoteNewPage} — the operator add-note form.
 *  - {@link adminNoteDeletePage} — the are-you-sure delete page (NOT the
 *    copy/paste confirmation), returning to wherever the operator came from.
 */

import { groupNotesByTargetId } from "#db/notes/target.ts";
/* jscpd:ignore-start */
import type { SystemNote } from "#db/notes/types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { hiddenInputs } from "#shared/forms/hidden-inputs.tsx";
import { renderField } from "#shared/forms/rendering.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown, withoutLinksTo } from "#shared/markdown.ts";
import { withReturnUrl } from "#shared/return-url-field.tsx";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { type AdminSession, isOwnerRole } from "#types";

/* jscpd:ignore-end */

/** Fields shared by the note page templates: the operator's session, where to
 *  send them back to, and any error to show. */
type NotePageProps = {
  session: AdminSession;
  returnUrl: string;
  error?: string | undefined;
};

/** The attendee edit page — where the note controls return after an action. */
const attendeeUrl = (attendeeId: number): string =>
  `/admin/attendees/${attendeeId}`;

/** The are-you-sure delete page for one note, returning to `returnUrl`. */
const noteDeleteAction = (note: SystemNote): string =>
  `/admin/attendee/${note.entity_id}/note/${note.id}/delete`;

const deleteNoteUrl = (note: SystemNote, returnUrl: string): string =>
  withReturnUrl(noteDeleteAction(note), returnUrl);

/** One note plus whether the viewer is an owner. Only an owner can open the
 * ledger pages a note may link to. */
type NoteViewProps = {
  isOwner: boolean;
  note: SystemNote;
};

/** A collection of notes plus whether the viewer is an owner. Shared by the
 * note section, the summary, and the attendee banner so the `{ notes, isOwner }`
 * pair has one declared shape. */
export type NotesViewProps = {
  notes: SystemNote[];
  isOwner: boolean;
};

/** True when a link target is an owner-only page — the standalone ledger routes
 * (`/admin/ledger…`) and the attendee page's ledger tab
 * (`/admin/attendees/:id/ledger`). A non-owner's note renders the words without
 * the link, since a rendered link is a promise that it works. */
const isOwnerOnlyLink = (href: string): boolean =>
  href.startsWith("/admin/ledger") ||
  (href.startsWith("/admin/attendees/") && href.includes("/ledger"));

/** Render a note's body as (safe) markdown — links and emphasis, HTML escaped.
 * The ledger pages are owner-only, so for any other admin a stored ledger link
 * (the refund notes carry one) is demoted to its plain text — a rendered link
 * is a promise that it works. The render resolves the note's img#N references
 * through the request's page-image slot. */
const NoteBody = ({ isOwner, note }: NoteViewProps): JSX.Element => (
  <Raw
    html={renderMarkdown(
      isOwner ? note.note : withoutLinksTo(note.note, isOwnerOnlyLink),
    )}
  />
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
 * delete confirmation, returning to the record page.
 */
const NoteBox = ({
  deleteHref,
  isOwner,
  note,
}: NoteViewProps & {
  deleteHref: (note: SystemNote) => string;
}): JSX.Element => {
  const isSystem = note.type === "system";
  return (
    <div
      class={isSystem ? "system-note system-note-alert" : "system-note"}
      role={isSystem ? "alert" : undefined}
    >
      <WritableOnly>
        <a
          aria-label={t("notes.delete")}
          class="system-note-dismiss"
          href={deleteHref(note)}
          title={t("notes.delete")}
        >
          ×
        </a>
      </WritableOnly>
      {isSystem && (
        <span class="system-note-tag">{t("notes.system_label")}</span>
      )}
      <NoteBody isOwner={isOwner} note={note} />
      <p class="muted small">{formatDatetimeShort(note.created)}</p>
    </div>
  );
};

/**
 * The notes block on a record's page: every note (oldest first). Renders
 * nothing when the record has no notes, so the page carries no empty
 * `.attendee-notes` section. The "Add a note" link lives beside the page
 * heading (see {@link AddNoteLink}), not here.
 */
export const NotesSection = ({
  deleteHref,
  notes,
  isOwner,
}: NotesViewProps & {
  /** Mint one note's are-you-sure delete URL, returning to the record page. */
  deleteHref: (note: SystemNote) => string;
}): JSX.Element | null =>
  notes.length === 0 ? null : (
    <section class="attendee-notes">
      {notes.map((note) => (
        <NoteBox deleteHref={deleteHref} isOwner={isOwner} note={note} />
      ))}
    </section>
  );

/** The notes block on the attendee page: {@link NotesSection} with the
 * attendee's own delete URLs. */
export const AttendeeNotesSection = ({
  notes,
  isOwner,
}: NotesViewProps): JSX.Element | null =>
  NotesSection({
    deleteHref: (note) => deleteNoteUrl(note, attendeeUrl(note.entity_id)),
    isOwner,
    notes,
  });

/**
 * The "Add a note" link shown next to a record's page heading. Returns to
 * the record page after adding.
 */
export const AddNoteLink = ({ href }: { href: string }): JSX.Element => (
  <p>
    <a href={href}>{t("notes.add_link")}</a>
  </p>
);

/** The prose-extra slot for a record page: the "Add a note" link beside the
 * heading, hidden in read-only mode. `href` carries the note page URL with its
 * return-url query. */
export const addNoteLinkProse = (href: string): Promise<JSX.Element | null> =>
  Promise.resolve(isReadOnly() ? null : AddNoteLink({ href }));

/**
 * A red expandable shown above an attendee list when any listed attendee has
 * notes: each attendee (linked) and their notes, in order. Read-only — managing
 * a note happens from its attendee page. Renders nothing when there are none.
 */
export const AttendeeNotesSummary = ({
  notes,
  names,
  isOwner,
}: NotesViewProps & { names: Map<number, string> }): JSX.Element | null => {
  if (notes.length === 0) return null;
  const grouped = groupNotesByTargetId(notes);
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
              <NoteBody isOwner={isOwner} note={note} />
            </div>
          ))}
        </div>
      ))}
    </details>
  );
};

/** The operator add-note page. `noteAction` is the record kind's POST target
 * (for example `/admin/questions/7/note`), and `activeSection` the nav section
 * the note pages belong to. */
export const adminNoteNewPage = ({
  recordName,
  session,
  returnUrl,
  error,
  noteAction,
  activeSection,
}: {
  recordName: string;
  noteAction: string;
  activeSection: string;
} & NotePageProps): string =>
  renderAdminPageSpec({
    active: { section: activeSection },
    body: (
      <>
        <div class="prose">
          <h1>{t("notes.add_heading", { name: recordName })}</h1>
        </div>
        <CsrfForm action={noteAction}>
          {hiddenInputs([["return_url", returnUrl]])}
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
      </>
    ),
    flash: { error },
    session,
    title: t("notes.add_title"),
  });

/**
 * The are-you-sure delete page. Shows the note being deleted then a plain
 * confirm button (no copy/paste name confirmation), bouncing back to
 * `returnUrl` on confirm or cancel. Calls ConfirmPage directly: its props-bag
 * signature with a returnUrl doesn't fit the (entity, session, error?) shape
 * entityDeletePage builds.
 */
export const adminNoteDeletePage = ({
  note,
  session,
  returnUrl,
  error,
  noteAction,
  activeSection,
}: {
  note: SystemNote;
  noteAction: (note: SystemNote) => string;
  activeSection: string;
} & NotePageProps): string =>
  ConfirmPage({
    action: noteAction(note),
    active: { section: activeSection },
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
        <NoteBody isOwner={isOwnerRole(session.adminLevel)} note={note} />
      </div>
    ),
    returnUrl,
    session,
    title: t("notes.delete_title"),
  });
