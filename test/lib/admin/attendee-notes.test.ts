import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { getNoteRows, getNotesForAttendee } from "#shared/db/system-notes.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectRedirectWithFlash,
  getTestPrivateKey,
  setupAdminTest,
} from "#test-utils";

describeWithEnv("admin > attendee notes routes", { db: true }, () => {
  test("GET renders the add-note form for an existing attendee", async () => {
    const { attendee } = await setupAdminTest();
    const { response } = await adminGet(`/admin/attendee/${attendee.id}/note`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="/admin/attendee/${attendee.id}/note"`);
    expect(html).toContain('name="note"');
  });

  test("GET on a missing attendee is a 404", async () => {
    await setupAdminTest();
    const { response } = await adminGet("/admin/attendee/999999/note");
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

    const notes = await getNotesForAttendee(
      attendee.id,
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
    expect(await response.text()).toContain("Enter a note");
    expect(await getNoteRows([attendee.id])).toEqual([]);
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
    const [row] = await getNoteRows([attendee.id]);

    const { response } = await adminGet(
      `/admin/attendee/${attendee.id}/note/${row!.id}/delete`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Are you sure");
    expect(html).toContain("deletable note");
    // The intermediate page never asks for the copy/paste confirmation.
    expect(html).not.toContain('name="confirm_identifier"');
  });

  test("GET delete on a missing note is a 404", async () => {
    const { attendee } = await setupAdminTest();
    const { response } = await adminGet(
      `/admin/attendee/${attendee.id}/note/424242/delete`,
    );
    expect(response.status).toBe(404);
  });

  test("POST delete removes the note and returns to return_url", async () => {
    const { attendee, listing } = await setupAdminTest();
    await adminFormPost(`/admin/attendee/${attendee.id}/note`, {
      note: "to be deleted",
    });
    const [row] = await getNoteRows([attendee.id]);
    const returnUrl = `/admin/listing/${listing.id}`;

    const { response } = await adminFormPost(
      `/admin/attendee/${attendee.id}/note/${row!.id}/delete`,
      { return_url: returnUrl },
    );
    // Redirects to the return target with a SUCCESS flash confirming deletion.
    expectRedirectWithFlash(returnUrl, t("notes.deleted"), true)(response);
    expect(await getNoteRows([attendee.id])).toEqual([]);
  });
});
