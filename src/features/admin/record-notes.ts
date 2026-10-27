/**
 * The add-and-delete note routes every record kind with a notes section needs.
 * A record kind supplies how it loads its records and how its note URLs are
 * shaped. The four routes (add GET/POST, delete GET/POST) are the same for
 * every kind, so one factory serves attendees, groups, and listings alike.
 * The factory hands back the record page's banner wiring from the same
 * config.
 */

import { addNoteImageUrls, addPageImageUrls } from "#db/image-urls.ts";
import {
  createOwnerNote,
  deleteNotes,
  getNote,
  getNotesFor,
} from "#db/notes/queries.ts";
import { type NoteEntity, noteTargets } from "#db/notes/target.ts";
import type { SystemNote } from "#db/notes/types.ts";
import { t } from "#i18n";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createEntityHandler } from "#routes/entity.ts";
import {
  htmlResponse,
  notFoundResponse,
  orResponse,
  redirect,
} from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { withReturnUrl } from "#shared/return-url-field.tsx";
import {
  getSessionPrivateKey,
  requireRequestPrivateKey,
} from "#shared/session-private-key.ts";
import {
  addNoteLinkProse,
  adminNoteDeletePage,
  adminNoteNewPage,
  NotesSection,
} from "#templates/admin/attendee-notes.tsx";
import { isOwnerRole, isStaffRole } from "#types";
import { type AuthOption, resolveAuth } from "./confirmation.ts";

export interface RecordNoteRoutesConfig<Record extends { id: number }> {
  /** The nav section the note pages highlight (the record's own section). */
  activeSection: string;
  /** Who can use this record kind's note routes: "any" (the staff floor
   * `requireSessionOr` enforces) or "owner". A record's notes never reach
   * past its own page's audience. An owner-only record passes "owner":
   * wider note routes widen the record page's own audience floor. */
  auth: AuthOption<AuthSession>;
  /** The kind of record the notes are about. */
  entityKind: NoteEntity;
  /** Load one record by id, or null when it does not exist. */
  loadRecord: (id: number, session: AuthSession) => Promise<Record | null>;
  /** The record's display name for the add-note heading. */
  nameOf: (record: Record) => string;
  /** One record's notes base path: `/admin/groups/7/note`. */
  noteBasePath: (id: number) => string;
  /** The record's own page, where note actions return by default. */
  recordPagePath: (id: number) => string;
}

/** A note-delete route: the record's id and the note's own id. */
type NoteDeleteHandler = (
  request: Request,
  id: number,
  noteId: number,
) => Promise<Response>;

/** The four note routes, id-first so a caller binds them to its own route
 * params. */
export interface RecordNoteHandlers {
  addGet: (request: Request, id: number) => Promise<Response>;
  addPost: (request: Request, id: number) => Promise<Response>;
  deleteGet: NoteDeleteHandler;
  deletePost: NoteDeleteHandler;
}

/** A handler that reads the record's id (and a note id for deletes) from the
 * route params. The id params (`:id`, `:attendeeId`, `:noteId`) are the ones
 * the router parses as numbers, so the casts below assert what the router
 * already guaranteed. */
const noteParamHandler =
  (
    idParam: string,
    run: (request: Request, id: number, noteId?: number) => Promise<Response>,
  ): RouteHandlerFn =>
  (request, params) =>
    run(
      request,
      params[idParam] as number,
      params.noteId as number | undefined,
    );

/** Bind the four note routes under a record kind's paths. `basePath` is the
 * record's path without the id (for example "/admin/groups"), `idParam` the
 * route param that names the record (for example "id"), and `routes` the
 * handlers to bind. The route-map shape is the one `defineRoutes` wants, so a
 * caller spreads the result into its route table. */
export const bindNoteRoutes = (
  basePath: string,
  idParam: string,
  routes: RecordNoteHandlers,
): Record<string, RouteHandlerFn> => {
  const noteBase = `${basePath}/:${idParam}/note`;
  return {
    [`GET ${noteBase}`]: noteParamHandler(idParam, (request, id) =>
      routes.addGet(request, id),
    ),
    [`GET ${noteBase}/:noteId/delete`]: noteParamHandler(
      idParam,
      (request, id, noteId) => routes.deleteGet(request, id, noteId as number),
    ),
    [`POST ${noteBase}`]: noteParamHandler(idParam, (request, id) =>
      routes.addPost(request, id),
    ),
    [`POST ${noteBase}/:noteId/delete`]: noteParamHandler(
      idParam,
      (request, id, noteId) => routes.deletePost(request, id, noteId as number),
    ),
  };
};

/** The page a note action returns to: the caller's `return_url`, or the
 * record's own page when none was supplied. Always non-empty, so the cancel
 * links and post-action redirects always lead somewhere sensible. */
const returnTo =
  (recordPagePath: (id: number) => string) =>
  (recordId: number, returnUrl: string): string =>
    returnUrl || recordPagePath(recordId);

/** One page slot over a record and the request's context. */
type RecordSlot<Entity, T> = (entity: Entity, ctx: PageCtx) => Promise<T>;

/** One record kind's notes feature: the four note routes its route table
 * binds, and the page wiring its record page composes from the same config. */
export interface RecordNoteFeature<Record extends { id: number }> {
  page: {
    /** The notes section as the record page's whole banner, or null for a
     * session that cannot decrypt notes (a content-only editor). A page whose
     * banner carries more composes its own from notesFor and noteDeleteUrl. */
    banner: RecordSlot<Record, JSX.Element | null>;
    noteDeleteUrl: (note: SystemNote) => string;
    /** One record's notes, decrypted, with image references resolved. Empty
     * for a session that cannot derive the owner key. */
    notesFor: (entity: Record, session: AuthSession) => Promise<SystemNote[]>;
    /** The "Add a note" link beside the heading, returning to the record
     * page. Staff-only, like the banner. */
    proseExtra: RecordSlot<Record, JSX.Element | null>;
  };
  routes: RecordNoteHandlers;
}

export const recordNoteFeature = <Record extends { id: number }>(
  config: RecordNoteRoutesConfig<Record>,
): RecordNoteFeature<Record> => {
  const { activeSection, entityKind, loadRecord, nameOf, noteBasePath } =
    config;
  const { requireSession, withForm } = resolveAuth(config.auth);
  const targetOf = noteTargets.of(entityKind);
  const recordReturn = returnTo(config.recordPagePath);

  /** The record, or a 404 Response when it does not exist. Both add pages
   * need the record to exist, and the form needs its name. */
  const loadRecordOr404 = async (
    id: number,
    session: AuthSession,
  ): Promise<Record | Response> =>
    (await loadRecord(id, session)) ?? notFoundResponse();

  const withLoadedRecord = async (
    id: number,
    session: AuthSession,
    then: ResponseHandler<[record: Record]>,
  ): Promise<Response> => orResponse(await loadRecordOr404(id, session), then);

  /** Render the add-note form for a loaded record (initial GET or a re-render
   * after a rejected save). */
  const renderAddNote = (
    record: Record,
    session: AuthSession,
    returnUrl: string,
    error: string | undefined,
    status?: number,
  ): Response =>
    htmlResponse(
      adminNoteNewPage({
        activeSection,
        error,
        noteAction: noteBasePath(record.id),
        recordName: nameOf(record),
        returnUrl: recordReturn(record.id, returnUrl),
        session,
      }),
      status,
    );

  const addGet: RecordNoteHandlers["addGet"] = (request, id) =>
    requireSession(request, (session) =>
      withLoadedRecord(id, session, (record) =>
        renderAddNote(
          record,
          session,
          getSearchParam(request, "return_url"),
          applyFlash(request).error,
        ),
      ),
    );

  const addPost: RecordNoteHandlers["addPost"] = (request, id) =>
    withForm(request, async (session, form) =>
      withLoadedRecord(id, session, async (record) => {
        const note = form.getString("note").trim();
        const returnUrl = form.getString("return_url");
        // Re-render in place on a blank note (preserving the return target)
        // rather than redirect — nothing to preserve, no PRG round-trip needed.
        if (!note) {
          return renderAddNote(
            record,
            session,
            returnUrl,
            t("notes.empty_error"),
            400,
          );
        }
        await createOwnerNote(targetOf(record.id), note);
        return redirect(
          recordReturn(record.id, returnUrl),
          t("notes.added"),
          true,
        );
      }),
    );

  type NoteRouteParams = { id: number; noteId: number };
  const loadNote = async ({
    id,
    noteId,
  }: NoteRouteParams): Promise<SystemNote | null> =>
    getNote(targetOf(id), noteId, await requireRequestPrivateKey());
  const noteEntityHandler = createEntityHandler<NoteRouteParams, SystemNote>(
    loadNote,
  );
  const noteHandlers = {
    get: noteEntityHandler(requireSession),
    post: noteEntityHandler(withForm),
  };

  const deleteGet: RecordNoteHandlers["deleteGet"] = (request, id, noteId) =>
    noteHandlers.get(async (note, session, request, _params) => {
      await addPageImageUrls([note.note]);
      return htmlResponse(
        adminNoteDeletePage({
          activeSection,
          error: applyFlash(request).error,
          note,
          noteAction: (note) =>
            `${noteBasePath(note.entity_id)}/${note.id}/delete`,
          returnUrl: recordReturn(id, getSearchParam(request, "return_url")),
          session,
        }),
      );
    })(request, { id, noteId });

  const deletePost: RecordNoteHandlers["deletePost"] = (request, id, noteId) =>
    noteHandlers.post(async (note, _session, form) => {
      await deleteNotes(targetOf(note.entity_id), [note.id]);
      return redirect(
        recordReturn(note.entity_id, form.getString("return_url")),
        t("notes.deleted"),
        true,
      );
    })(request, { id, noteId });

  /** One note's are-you-sure delete URL, returning to the record page. */
  const noteDeleteUrl = (note: SystemNote): string =>
    withReturnUrl(
      `${config.noteBasePath(note.entity_id)}/${note.id}/delete`,
      config.recordPagePath(note.entity_id),
    );

  /** One record's notes, decrypted, with image references resolved. A session
   * that cannot derive the owner key reads none: a content-only editor, or a
   * session whose wrapped key is unavailable. The banner is decoration, and
   * must never break the page under it. */
  const notesFor = async (
    entity: Record,
    session: AuthSession,
  ): Promise<SystemNote[]> => {
    const key = await getSessionPrivateKey(session);
    if (!key) return [];
    const loaded = await getNotesFor(targetOf(entity.id), key);
    await addNoteImageUrls(loaded);
    return loaded;
  };

  /** Whether the session can read owner-key-encrypted notes at all: the staff
   * floor. A content-only editor cannot decrypt them. */
  const staffSession = (ctx: PageCtx): boolean =>
    isStaffRole(ctx.session.adminLevel);

  return {
    page: {
      banner: async (entity, ctx) => {
        if (!staffSession(ctx)) return null;
        const isOwner = isOwnerRole(ctx.session.adminLevel);
        return NotesSection({
          deleteHref: noteDeleteUrl,
          isOwner,
          notes: await notesFor(entity, ctx.session),
        });
      },
      noteDeleteUrl,
      notesFor,
      /** The "Add a note" link beside the heading, returning to the record
       * page. Staff-only, like the notes it opens. Read-only mode hides it
       * by the shared link renderer. */
      proseExtra: (entity, ctx) => {
        if (!staffSession(ctx)) return Promise.resolve(null);
        return addNoteLinkProse(
          withReturnUrl(
            config.noteBasePath(entity.id),
            config.recordPagePath(entity.id),
          ),
        );
      },
    },
    routes: { addGet, addPost, deleteGet, deletePost },
  };
};
