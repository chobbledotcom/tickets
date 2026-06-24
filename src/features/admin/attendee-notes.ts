/**
 * Admin routes for per-attendee operator notes.
 *
 *   GET  /admin/attendee/:attendeeId/note                  — add-note form
 *   POST /admin/attendee/:attendeeId/note                  — create an owner note
 *   GET  /admin/attendee/:attendeeId/note/:noteId/delete   — are-you-sure page
 *   POST /admin/attendee/:attendeeId/note/:noteId/delete   — delete the note
 *
 * Owner notes are encrypted with the owner public key; the read paths derive the
 * request private key (an admin session always has it — the same key that
 * decrypts attendee PII). Every action carries a `return_url` so the operator is
 * bounced back to wherever they were (the attendee page, or a listing/attendee
 * list a `×` was clicked from).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getAttendee } from "#shared/db/attendees.ts";
import {
  createOwnerNote,
  deleteAttendeeNote,
  getAttendeeNote,
} from "#shared/db/system-notes.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { AdminSession, Attendee } from "#shared/types.ts";
import {
  adminAddNotePage,
  adminDeleteNotePage,
} from "#templates/admin/attendee-notes.tsx";

/* jscpd:ignore-end */

/** The page to return to after a note action: the caller's `return_url`, or the
 * attendee's own page when none was supplied. Always non-empty, so the cancel
 * links and post-action redirects always lead somewhere sensible. */
const returnTarget = (attendeeId: number, returnUrl: string): string =>
  returnUrl || `/admin/attendees/${attendeeId}`;

/** The decrypted attendee, or a 404 Response to return when it doesn't exist —
 * both add pages need the attendee to exist (and the form needs its name). */
const loadAttendeeOr404 = async (
  attendeeId: number,
): Promise<Attendee | Response> => {
  const attendee = await getAttendee(
    attendeeId,
    await requireRequestPrivateKey(),
  );
  return attendee ?? notFoundResponse();
};

/** Render the add-note form for a loaded attendee (initial GET or a re-render
 * after a rejected save). */
const renderAddNote = (
  attendee: Attendee,
  session: AdminSession,
  returnUrl: string,
  error: string | undefined,
  status?: number,
): Response =>
  htmlResponse(
    adminAddNotePage({
      attendeeId: attendee.id,
      attendeeName: attendee.name,
      error,
      returnUrl: returnTarget(attendee.id, returnUrl),
      session,
    }),
    status,
  );

/** GET /admin/attendee/:attendeeId/note — render the add-note form. */
const handleAddNoteGet: TypedRouteHandler<
  "GET /admin/attendee/:attendeeId/note"
> = (request, { attendeeId }) =>
  requireSessionOr(request, async (session) => {
    const attendee = await loadAttendeeOr404(attendeeId);
    if (attendee instanceof Response) return attendee;
    return renderAddNote(
      attendee,
      session,
      getSearchParam(request, "return_url"),
      applyFlash(request).error,
    );
  });

/** POST /admin/attendee/:attendeeId/note — create an owner note. */
const handleAddNotePost: TypedRouteHandler<
  "POST /admin/attendee/:attendeeId/note"
> = (request, { attendeeId }) =>
  withAuth(request, AUTH_FORM, async (session, form) => {
    const attendee = await loadAttendeeOr404(attendeeId);
    if (attendee instanceof Response) return attendee;
    const note = form.getString("note").trim();
    const returnUrl = form.getString("return_url");
    // Re-render in place on a blank note (preserving the return target) rather
    // than redirect — there is nothing to preserve and no PRG round-trip needed.
    if (!note) {
      return renderAddNote(
        attendee,
        session,
        returnUrl,
        t("notes.empty_error"),
        400,
      );
    }
    await createOwnerNote(attendeeId, note);
    return redirect(
      returnTarget(attendeeId, returnUrl),
      t("notes.added"),
      true,
    );
  });

/** GET /admin/attendee/:attendeeId/note/:noteId/delete — are-you-sure page. */
const handleDeleteNoteGet: TypedRouteHandler<
  "GET /admin/attendee/:attendeeId/note/:noteId/delete"
> = (request, { attendeeId, noteId }) =>
  requireSessionOr(request, async (session) => {
    const note = await getAttendeeNote(
      attendeeId,
      noteId,
      await requireRequestPrivateKey(),
    );
    if (!note) return notFoundResponse();
    return htmlResponse(
      adminDeleteNotePage({
        error: applyFlash(request).error,
        note,
        returnUrl: returnTarget(
          attendeeId,
          getSearchParam(request, "return_url"),
        ),
        session,
      }),
    );
  });

/** POST /admin/attendee/:attendeeId/note/:noteId/delete — delete the note. */
const handleDeleteNotePost: TypedRouteHandler<
  "POST /admin/attendee/:attendeeId/note/:noteId/delete"
> = (request, { attendeeId, noteId }) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    await deleteAttendeeNote(attendeeId, noteId);
    return redirect(
      returnTarget(attendeeId, form.getString("return_url")),
      t("notes.deleted"),
      true,
    );
  });

export const attendeeNotesRoutes = defineRoutes({
  "GET /admin/attendee/:attendeeId/note": handleAddNoteGet,
  "GET /admin/attendee/:attendeeId/note/:noteId/delete": handleDeleteNoteGet,
  "POST /admin/attendee/:attendeeId/note": handleAddNotePost,
  "POST /admin/attendee/:attendeeId/note/:noteId/delete": handleDeleteNotePost,
});
