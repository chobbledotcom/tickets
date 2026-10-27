import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getNoteRows } from "#db/notes/queries.ts";
import { t } from "#i18n";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createQuestion } from "#test-utils/questions/helpers.ts";
import { expectSingleQuestionNote } from "#test-utils/questions/notes.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("admin > question notes routes", { db: true }, () => {
  test("GET renders the add-note form for an existing question", async () => {
    const id = await createQuestion("What size?");
    const response = await adminGet(`/admin/questions/${id}/note`);
    expect(response.status).toBe(200);
    const html = await response.text();
    assertStringIncludes(html, `action="/admin/questions/${id}/note"`);
    assertStringIncludes(html, 'name="note"');
  });

  test("GET on a missing question is a 404", async () => {
    const response = await adminGet("/admin/questions/999999/note");
    expect(response.status).toBe(404);
  });

  test("POST creates an owner note and returns to the question page", async () => {
    const id = await createQuestion("What size?");
    const { response } = await adminFormPost(`/admin/questions/${id}/note`, {
      note: "Check the wording before the season",
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("notes.added"),
      true,
    )(response);

    await expectSingleQuestionNote(id, "Check the wording before the season");
  });

  test("POST with a blank note re-renders the form with an error and saves nothing", async () => {
    const id = await createQuestion("What size?");
    const { response } = await adminFormPost(`/admin/questions/${id}/note`, {
      note: "   ",
    });
    expect(response.status).toBe(400);
    assertStringIncludes(await response.text(), "Enter a note");
    expect(await getNoteRows("question", [id])).toEqual([]);
  });

  test("POST on a missing question is a 404", async () => {
    const { response } = await adminFormPost("/admin/questions/999999/note", {
      note: "orphan",
    });
    expect(response.status).toBe(404);
  });

  test("GET renders the are-you-sure delete page for a note", async () => {
    const id = await createQuestion("What size?");
    await adminFormPost(`/admin/questions/${id}/note`, { note: "deletable" });
    const [row] = await getNoteRows("question", [id]);

    const response = await adminGet(
      `/admin/questions/${id}/note/${row!.id}/delete`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    assertStringIncludes(html, "Are you sure");
    assertStringIncludes(html, "deletable");
    // The intermediate page never asks for the copy/paste confirmation.
    assert(!html.includes('name="confirm_identifier"'));
  });

  test("GET delete on a missing note is a 404", async () => {
    const id = await createQuestion("What size?");
    const response = await adminGet(
      `/admin/questions/${id}/note/424242/delete`,
    );
    expect(response.status).toBe(404);
  });

  test("POST delete removes the note and returns to the question page", async () => {
    const id = await createQuestion("What size?");
    await adminFormPost(`/admin/questions/${id}/note`, {
      note: "to be deleted",
    });
    const [row] = await getNoteRows("question", [id]);

    const { response } = await adminFormPost(
      `/admin/questions/${id}/note/${row!.id}/delete`,
    );
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("notes.deleted"),
      true,
    )(response);
    expect(await getNoteRows("question", [id])).toEqual([]);
  });

  test("POST delete on a missing note is a 404", async () => {
    const id = await createQuestion("What size?");
    const { response } = await adminFormPost(
      `/admin/questions/${id}/note/424242/delete`,
    );
    expect(response.status).toBe(404);
  });
});
