import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getNoteRows, getNotesFor } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import { t } from "#i18n";
import { setupAdminTest } from "#test-utils/admin-fixture.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("admin > attendee notes routes", { db: true }, () => {
  test("GET renders the add-note form for an existing attendee", async () => {
    const { attendee } = await setupAdminTest();
    const response = await adminGet(`/admin/attendee/${attendee.id}/note`);
    expect(response.status).toBe(200);
    const html = await response.text();
    assertStringIncludes(html, `action="/admin/attendee/${attendee.id}/note"`);
    assertStringIncludes(html, 'name="note"');
  });

  test("GET on a missing attendee is a 404", async () => {
    await setupAdminTest();
    const response = await adminGet("/admin/attendee/999999/note");
    expect(response.status).toBe(404);
  });

  test("POST creates an owner note and returns to return_url", async () => {
    const { attendee, listing } = await setupAdminTest();
    const returnUrl = `/admin/listing/${listing.id}`;
    const { response } = await adminFormPost(
      `/admin/attendee/${attendee.id}/note`,
      { note: "Spoke to them on the phone", return_url: returnUrl },
    );
    // Redirects to the return target with a SUCCESS flash naming the action.
    expectRedirectWithFlash(returnUrl, t("notes.added"), true)(response);

    const notes = await getNotesFor(
      attendeeNotes(attendee.id),
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      note: "Spoke to them on the phone",
      type: "owner",
    });
  });

  test("POST with a blank note re-renders the form with an error and saves nothing", async () => {
    const { attendee } = await setupAdminTest();
    const { response } = await adminFormPost(
      `/admin/attendee/${attendee.id}/note`,
      { note: "   " },
    );
    expect(response.status).toBe(400);
    assertStringIncludes(await response.text(), "Enter a note");
    expect(await getNoteRows("attendee", [attendee.id])).toEqual([]);
  });

  test("POST on a missing attendee is a 404", async () => {
    await setupAdminTest();
    const { response } = await adminFormPost("/admin/attendee/999999/note", {
      note: "orphan",
    });
    expect(response.status).toBe(404);
  });

  test("GET renders the are-you-sure delete page for a note", async () => {
    const { attendee } = await setupAdminTest();
    await adminFormPost(`/admin/attendee/${attendee.id}/note`, {
      note: "deletable note",
    });
    const [row] = await getNoteRows("attendee", [attendee.id]);

    const response = await adminGet(
      `/admin/attendee/${attendee.id}/note/${row!.id}/delete`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    assertStringIncludes(html, "Are you sure");
    assertStringIncludes(html, "deletable note");
    // The intermediate page never asks for the copy/paste confirmation.
    assert(!html.includes('name="confirm_identifier"'));
  });

  test("GET delete resolves the note's img#N reference", async () => {
    const { attendee } = await setupAdminTest();
    const image = await makeImage("DeletePoster");
    await adminFormPost(`/admin/attendee/${attendee.id}/note`, {
      note: `Remove me. ![DeletePoster](img#${image.id})`,
    });
    const [row] = await getNoteRows("attendee", [attendee.id]);

    const html = await (
      await adminGet(`/admin/attendee/${attendee.id}/note/${row!.id}/delete`)
    ).text();
    assertStringIncludes(
      html,
      `<img src="/image/${image.filename}" alt="DeletePoster">`,
    );
    assert(!html.includes("img#"));
  });

  test("GET delete on a missing note is a 404", async () => {
    const { attendee } = await setupAdminTest();
    const response = await adminGet(
      `/admin/attendee/${attendee.id}/note/424242/delete`,
    );
    expect(response.status).toBe(404);
  });

  test("POST delete removes the note and returns to return_url", async () => {
    const { attendee, listing } = await setupAdminTest();
    await adminFormPost(`/admin/attendee/${attendee.id}/note`, {
      note: "to be deleted",
    });
    const [row] = await getNoteRows("attendee", [attendee.id]);
    const returnUrl = `/admin/listing/${listing.id}`;

    const { response } = await adminFormPost(
      `/admin/attendee/${attendee.id}/note/${row!.id}/delete`,
      { return_url: returnUrl },
    );
    // Redirects to the return target with a SUCCESS flash confirming deletion.
    expectRedirectWithFlash(returnUrl, t("notes.deleted"), true)(response);
    expect(await getNoteRows("attendee", [attendee.id])).toEqual([]);
  });

  test("POST delete on a missing note is a 404", async () => {
    const { attendee } = await setupAdminTest();
    const { response } = await adminFormPost(
      `/admin/attendee/${attendee.id}/note/424242/delete`,
    );

    expect(response.status).toBe(404);
  });
});
