import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/**
 * Owner notes are encrypted with the owner public key. The read paths derive
 * the request private key, which an admin session always has, because the same
 * key decrypts attendee PII. Every action carries a `return_url`, so the
 * operator lands back where they were.
 */

import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { createOwnerNote, deleteNotes, getNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import type { SystemNote } from "#db/notes/types.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { attendeeFormPost } from "#routes/admin/attendees-route-helpers.ts";
import { AUTH_FORM, formGuard, requireSessionOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createEntityHandler } from "#routes/entity.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  adminNoteDeletePage,
  adminNoteNewPage,
} from "#templates/admin/attendee-notes.tsx";
import type { AdminSession, Attendee } from "#types";

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
  const attendee = await getAttendeeOrNull(
    attendeeId,
    await requireRequestPrivateKey(),
  );
  return attendee ?? notFoundResponse();
};

/** Load the attendee, then run `then` with it — or short-circuit to the 404
 * Response when it doesn't exist. */
const withLoadedAttendee = async (
  attendeeId: number,
  then: ResponseHandler<[attendee: Attendee]>,
): Promise<Response> => {
  const attendee = await loadAttendeeOr404(attendeeId);
  return attendee instanceof Response ? attendee : then(attendee);
};

type NoteRouteParams = { attendeeId: number; noteId: number };
const loadNote = async ({
  attendeeId,
  noteId,
}: NoteRouteParams): Promise<SystemNote | null> =>
  getNote(attendeeNotes(attendeeId), noteId, await requireRequestPrivateKey());
const noteEntityHandler = createEntityHandler<NoteRouteParams, SystemNote>(
  loadNote,
);
const noteHandlers = {
  get: noteEntityHandler(requireSessionOr),
  post: noteEntityHandler(formGuard(AUTH_FORM)),
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
    adminNoteNewPage({
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
  requireSessionOr(request, (session) =>
    withLoadedAttendee(attendeeId, (attendee) =>
      renderAddNote(
        attendee,
        session,
        getSearchParam(request, "return_url"),
        applyFlash(request).error,
      ),
    ),
  );

/** POST /admin/attendee/:attendeeId/note — create an owner note. */
const handleAddNotePost: TypedRouteHandler<"POST /admin/attendee/:attendeeId/note"> =
  attendeeFormPost((attendeeId, session, form) =>
    withLoadedAttendee(attendeeId, async (attendee) => {
      const note = form.getString("note").trim();
      const returnUrl = form.getString("return_url");
      // Re-render in place on a blank note (preserving the return target)
      // rather than redirect — nothing to preserve, no PRG round-trip needed.
      if (!note) {
        return renderAddNote(
          attendee,
          session,
          returnUrl,
          t("notes.empty_error"),
          400,
        );
      }
      await createOwnerNote(attendeeNotes(attendeeId), note);
      return redirect(
        returnTarget(attendeeId, returnUrl),
        t("notes.added"),
        true,
      );
    }),
  );

/** GET /admin/attendee/:attendeeId/note/:noteId/delete — are-you-sure page. */
const handleDeleteNoteGet: TypedRouteHandler<"GET /admin/attendee/:attendeeId/note/:noteId/delete"> =
  noteHandlers.get((note, session, request, { attendeeId }) =>
    htmlResponse(
      adminNoteDeletePage({
        error: applyFlash(request).error,
        note,
        returnUrl: returnTarget(
          attendeeId,
          getSearchParam(request, "return_url"),
        ),
        session,
      }),
    ),
  );

/** POST /admin/attendee/:attendeeId/note/:noteId/delete — delete the note. */
const handleDeleteNotePost: TypedRouteHandler<"POST /admin/attendee/:attendeeId/note/:noteId/delete"> =
  noteHandlers.post(async (note, _session, form, _request, { attendeeId }) => {
    await deleteNotes(attendeeNotes(attendeeId), [note.id]);
    return redirect(
      returnTarget(attendeeId, form.getString("return_url")),
      t("notes.deleted"),
      true,
    );
  });

export const adminHandlers = defineRoutes({
  "GET /admin/attendee/:attendeeId/note": handleAddNoteGet,
  "GET /admin/attendee/:attendeeId/note/:noteId/delete": handleDeleteNoteGet,
  "POST /admin/attendee/:attendeeId/note": handleAddNotePost,
  "POST /admin/attendee/:attendeeId/note/:noteId/delete": handleDeleteNotePost,
});
