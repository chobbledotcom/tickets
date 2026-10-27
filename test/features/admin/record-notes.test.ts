/**
 * The shared record-notes route factory and its route-table binder. The four
 * note routes (add GET/POST, delete GET/POST) are tested directly here with a
 * question as the record kind; the per-kind bindings (attendee, question)
 * live in their own feature tests.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getNoteRows } from "#db/notes/queries.ts";
import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { t } from "#i18n";
import {
  bindNoteRoutes,
  recordNoteRoutes,
} from "#routes/admin/record-notes.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { createQuestion } from "#test-utils/questions/helpers.ts";
import { expectSingleQuestionNote } from "#test-utils/questions/notes.ts";
import { withTestSession } from "#test-utils/session.ts";

describe("bindNoteRoutes", () => {
  test("maps the four note routes to their handlers, id-first", () => {
    const calls: string[] = [];
    const routes = bindNoteRoutes("/admin/questions", "id", {
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
      "GET /admin/questions/:id/note",
      "GET /admin/questions/:id/note/:noteId/delete",
      "POST /admin/questions/:id/note",
      "POST /admin/questions/:id/note/:noteId/delete",
    ]);

    // The binder pulls the numeric id (and note id) out of the route params.
    routes["GET /admin/questions/:id/note"]!(
      new Request("http://localhost/x"),
      { id: 3 },
    );
    routes["POST /admin/questions/:id/note"]!(
      new Request("http://localhost/x"),
      { id: 4 },
    );
    routes["GET /admin/questions/:id/note/:noteId/delete"]!(
      new Request("http://localhost/x"),
      { id: 5, noteId: 9 },
    );
    routes["POST /admin/questions/:id/note/:noteId/delete"]!(
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

/** The factory configured for a question, the record kind the note routes
 *  serve in this test. */
const questionNoteRoutes = recordNoteRoutes({
  activeSection: adminPattern("questions"),
  entityKind: "question",
  loadRecord: (id) => getQuestionWithAnswers(id),
  nameOf: (question) => questionTextFlat(question.text),
  noteBasePath: (id) => `/admin/questions/${id}/note`,
  recordPagePath: (id) => `/admin/questions/${id}`,
});

/** POST a note through the factory and return the response. */
const postQuestionNote = async (
  id: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf = await signCsrfToken();
  return withTestSession(() =>
    questionNoteRoutes.addPost(
      mockFormRequest(`/admin/questions/${id}/note`, {
        csrf_token: csrf,
        ...fields,
      }),
      id,
    ),
  );
};

/** Create a question note through the factory and return its id. */
const createQuestionNote = async (
  id: number,
  note: string,
): Promise<number> => {
  await postQuestionNote(id, { note });
  const [row] = await getNoteRows("question", [id]);
  return row!.id;
};

describeWithEnv("record note routes", { db: true }, () => {
  test("addGet renders the add-note form for an existing record", async () => {
    const id = await createQuestion("What size?");
    const response = await withTestSession(() =>
      questionNoteRoutes.addGet(mockRequest(`/admin/questions/${id}/note`), id),
    );
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), 'name="note"');
  });

  test("addGet carries the return_url onto the form", async () => {
    const id = await createQuestion("What size?");
    const response = await withTestSession(() =>
      questionNoteRoutes.addGet(
        mockRequest(
          `/admin/questions/${id}/note?return_url=${encodeURIComponent("/admin/somewhere")}`,
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
      questionNoteRoutes.addGet(
        mockRequest("/admin/questions/99999/note"),
        99999,
      ),
    );
    expect(response.status).toBe(404);
  });

  test("addPost creates an owner note and returns to the record page", async () => {
    const id = await createQuestion("What size?");
    const response = await postQuestionNote(id, { note: "check the wording" });
    // No return_url, so the redirect lands on the record's own page.
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("notes.added"),
      true,
    )(response);
    await expectSingleQuestionNote(id, "check the wording");
  });

  test("addPost returns to a supplied return_url", async () => {
    const id = await createQuestion("What size?");
    const response = await postQuestionNote(id, {
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
    const id = await createQuestion("What size?");
    const response = await postQuestionNote(id, { note: "   " });
    expect(response.status).toBe(400);
    assertStringIncludes(await response.text(), t("notes.empty_error"));
    expect(await getNoteRows("question", [id])).toEqual([]);
  });

  test("deleteGet renders the are-you-sure page for a note", async () => {
    const id = await createQuestion("What size?");
    const noteId = await createQuestionNote(id, "deletable");

    const response = await withTestSession(() =>
      questionNoteRoutes.deleteGet(
        mockRequest(
          `/admin/questions/${id}/note/${noteId}/delete?return_url=${encodeURIComponent("/admin/somewhere")}`,
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
    const id = await createQuestion("What size?");
    const noteId = await createQuestionNote(id, "to be deleted");
    const csrf = await signCsrfToken();

    const response = await withTestSession(() =>
      questionNoteRoutes.deletePost(
        mockFormRequest(`/admin/questions/${id}/note/${noteId}/delete`, {
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
    expect(await getNoteRows("question", [id])).toEqual([]);
  });

  test("delete on a missing note is a 404", async () => {
    const id = await createQuestion("What size?");
    const response = await withTestSession(() =>
      questionNoteRoutes.deleteGet(
        mockRequest(`/admin/questions/${id}/note/424242/delete`),
        id,
        424242,
      ),
    );
    expect(response.status).toBe(404);
  });
});
