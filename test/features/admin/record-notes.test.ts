/**
 * The shared record-notes route factory and its route-table binder. The four
 * note routes (add GET/POST, delete GET/POST) are tested directly here with a
 * group as the record kind; the per-kind bindings (attendee, group, listing)
 * live in their own feature tests.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getGroupById } from "#db/groups.ts";
import { getNoteRows, getNotesFor } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { t } from "#i18n";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import {
  bindNoteRoutes,
  recordNoteFeature,
} from "#routes/admin/record-notes.ts";
import type { AuthSession } from "#routes/auth.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { getTestAuthSession, withTestSession } from "#test-utils/session.ts";

describe("bindNoteRoutes", () => {
  test("maps the four note routes to their handlers, id-first", () => {
    const calls: string[] = [];
    const routes = bindNoteRoutes("/admin/groups", "id", {
      addGet: async (_r, id) => {
        calls.push(`addGet:${id}`);
        return new Response();
      },
      addPost: async (_r, id) => {
        calls.push(`addPost:${id}`);
        return new Response();
      },
      deleteGet: async (_r, id, noteId) => {
        calls.push(`deleteGet:${id}:${noteId}`);
        return new Response();
      },
      deletePost: async (_r, id, noteId) => {
        calls.push(`deletePost:${id}:${noteId}`);
        return new Response();
      },
    });

    expect(Object.keys(routes).sort()).toEqual([
      "GET /admin/groups/:id/note",
      "GET /admin/groups/:id/note/:noteId/delete",
      "POST /admin/groups/:id/note",
      "POST /admin/groups/:id/note/:noteId/delete",
    ]);

    // The binder pulls the numeric id (and note id) out of the route params.
    routes["GET /admin/groups/:id/note"]!(new Request("http://localhost/x"), {
      id: 3,
    });
    routes["POST /admin/groups/:id/note"]!(new Request("http://localhost/x"), {
      id: 4,
    });
    routes["GET /admin/groups/:id/note/:noteId/delete"]!(
      new Request("http://localhost/x"),
      { id: 5, noteId: 9 },
    );
    routes["POST /admin/groups/:id/note/:noteId/delete"]!(
      new Request("http://localhost/x"),
      { id: 6, noteId: 10 },
    );
    expect(calls).toEqual([
      "addGet:3",
      "addPost:4",
      "deleteGet:5:9",
      "deletePost:6:10",
    ]);
  });
});

/** The factory configured for a group, the record kind the note routes
 *  serve in this test. */
const groupNoteFeature = recordNoteFeature({
  activeSection: adminPattern("groups"),
  entityKind: "group",
  loadRecord: (id) => getGroupById(id),
  nameOf: (group) => group.name,
  noteBasePath: (id) => `/admin/groups/${id}/note`,
  notePattern: "/admin/groups/:id/note",
  recordPagePath: (id) => `/admin/groups/${id}`,
});

/** Assert that a group carries exactly one note with the text. */
const expectSingleGroupNote = async (
  groupId: number,
  note: string,
): Promise<void> => {
  const notes = await getNotesFor(
    noteTargets.of("group")(groupId),
    await getTestPrivateKey(),
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    entity_id: groupId,
    entity_type: "group",
    note,
    type: "owner",
  });
};

/** POST a note through the factory and return the response. */
const postGroupNote = async (
  id: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf = await signCsrfToken();
  return withTestSession(() =>
    groupNoteFeature.routes.addPost(
      mockFormRequest(`/admin/groups/${id}/note`, {
        csrf_token: csrf,
        ...fields,
      }),
      id,
    ),
  );
};

/** Create a group note through the factory and return its id. */
const createGroupNote = async (id: number, note: string): Promise<number> => {
  await postGroupNote(id, { note });
  const [row] = await getNoteRows("group", [id]);
  return row!.id;
};

/** The parts of a page context the banner and prose slots read. */
const SESSION: AuthSession = {
  adminLevel: "owner",
  token: "t",
  userId: 1,
  wrappedDataKey: null,
};
const ctxFor = (session: AuthSession): PageCtx => ({ session }) as PageCtx;

describeWithEnv("record note routes", { db: true }, () => {
  test("addGet renders the add-note form for an existing record", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await withTestSession(() =>
      groupNoteFeature.routes.addGet(
        mockRequest(`/admin/groups/${id}/note`),
        id,
      ),
    );
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), 'name="note"');
  });

  test("addGet carries the return_url onto the form", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await withTestSession(() =>
      groupNoteFeature.routes.addGet(
        mockRequest(
          `/admin/groups/${id}/note?return_url=${encodeURIComponent("/admin/somewhere")}`,
        ),
        id,
      ),
    );
    const html = await response.text();
    assertStringIncludes(
      html,
      'name="return_url" type="hidden" value="/admin/somewhere"',
    );
  });

  test("addGet on a missing record is a 404", async () => {
    const response = await withTestSession(() =>
      groupNoteFeature.routes.addGet(
        mockRequest("/admin/groups/99999/note"),
        99999,
      ),
    );
    expect(response.status).toBe(404);
  });

  test("addPost creates an owner note and returns to the record page", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await postGroupNote(id, { note: "check the wording" });
    // No return_url, so the redirect lands on the record's own page.
    expectRedirectWithFlash(
      `/admin/groups/${id}`,
      t("notes.added"),
      true,
    )(response);
    await expectSingleGroupNote(id, "check the wording");
  });

  test("addPost returns to a supplied return_url", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await postGroupNote(id, {
      note: "from a listing",
      return_url: "/admin/listings/9",
    });
    expectRedirectWithFlash(
      "/admin/listings/9",
      t("notes.added"),
      true,
    )(response);
  });

  test("addPost re-renders with an error on a blank note", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await postGroupNote(id, { note: "   " });
    expect(response.status).toBe(400);
    assertStringIncludes(await response.text(), t("notes.empty_error"));
    expect(await getNoteRows("group", [id])).toEqual([]);
  });

  test("deleteGet renders the are-you-sure page for a note", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const noteId = await createGroupNote(id, "deletable");

    const response = await withTestSession(() =>
      groupNoteFeature.routes.deleteGet(
        mockRequest(
          `/admin/groups/${id}/note/${noteId}/delete?return_url=${encodeURIComponent("/admin/somewhere")}`,
        ),
        id,
        noteId,
      ),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    assertStringIncludes(html, "deletable");
    assertStringIncludes(
      html,
      'name="return_url" type="hidden" value="/admin/somewhere"',
    );
  });

  test("deletePost removes the note and returns to the record page", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const noteId = await createGroupNote(id, "to be deleted");
    const csrf = await signCsrfToken();

    const response = await withTestSession(() =>
      groupNoteFeature.routes.deletePost(
        mockFormRequest(`/admin/groups/${id}/note/${noteId}/delete`, {
          csrf_token: csrf,
          return_url: "/admin/listings/9",
        }),
        id,
        noteId,
      ),
    );
    expectRedirectWithFlash(
      "/admin/listings/9",
      t("notes.deleted"),
      true,
    )(response);
    expect(await getNoteRows("group", [id])).toEqual([]);
  });

  test("delete on a missing note is a 404", async () => {
    const { id } = await createTestGroup({ name: "What size?" });
    const response = await withTestSession(() =>
      groupNoteFeature.routes.deleteGet(
        mockRequest(`/admin/groups/${id}/note/424242/delete`),
        id,
        424242,
      ),
    );
    expect(response.status).toBe(404);
  });
});

describeWithEnv("the record page wiring", { db: true }, () => {
  test("the banner renders the notes for staff and nothing for an editor", async () => {
    const group = await createTestGroup({ name: "Banner record" });
    await createGroupNote(group.id, "a banner note");

    // The staff banner decrypts through the request's own keyed session; an
    // editor's session (no data key) reads none, and a keyless one would too.
    const staff = await withTestSession(async () => {
      const session = await getTestAuthSession();
      return groupNoteFeature.page.banner(group, ctxFor(session));
    });
    assertStringIncludes(String(staff), "a banner note");

    const editor = await groupNoteFeature.page.banner(
      group,
      ctxFor({ ...SESSION, adminLevel: "editor", wrappedDataKey: null }),
    );
    expect(editor).toBeNull();
  });

  test("proseExtra offers the add-note link to staff and nothing to an editor", async () => {
    const group = await createTestGroup({ name: "Prose record" });

    const staff = await withTestSession(() =>
      groupNoteFeature.page.proseExtra(
        group,
        ctxFor({ ...SESSION, adminLevel: "manager" }),
      ),
    );
    assertStringIncludes(
      String(staff),
      `/admin/groups/${group.id}/note?return_url=%2Fadmin%2Fgroups%2F${group.id}`,
    );

    const editor = await groupNoteFeature.page.proseExtra(
      group,
      ctxFor({ ...SESSION, adminLevel: "editor" }),
    );
    expect(editor).toBeNull();
  });
});
