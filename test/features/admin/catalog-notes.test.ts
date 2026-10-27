/**
 * The group and listing note routes. Both content kinds share the route
 * shapes, so one suite runs over each kind's record factory and paths; the
 * per-kind work is the table below.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getNoteRows, getNotesFor } from "#db/notes/queries.ts";
import { type NoteTarget, noteTargets } from "#db/notes/target.ts";
import { t } from "#i18n";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestEditorSession,
  postFormAs,
} from "#test-utils/session.ts";

/** One record kind the note routes serve, and how a test makes and addresses
 * one of its records. */
type NoteKind = {
  /** The note kind the database stores. */
  entity: "group" | "listing";
  /** The kind's name, for the describe label. */
  label: string;
  /** Create one record to hang notes on, named as asked. */
  create: (name: string) => Promise<{ id: number }>;
  /** One record's add-note path. */
  notePath: (id: number) => string;
  /** The record's own page, where note actions return. */
  pagePath: (id: number) => string;
};

const groupKind: NoteKind = {
  create: (name) => createTestGroup({ name }),
  entity: "group",
  label: "group",
  notePath: (id) => `/admin/groups/${id}/note`,
  pagePath: (id) => `/admin/groups/${id}`,
};

const listingKind: NoteKind = {
  create: (name) => createTestListing({ name }),
  entity: "listing",
  label: "listing",
  notePath: (id) => `/admin/listing/${id}/note`,
  pagePath: (id) => `/admin/listing/${id}`,
};

/** Assert that a record carries exactly the given owner-note texts. */
const expectNotes = async (
  kind: NoteKind,
  id: number,
  texts: string[],
): Promise<void> => {
  const target: NoteTarget = noteTargets.of(kind.entity)(id);
  const notes = await getNotesFor(target, await getTestPrivateKey());
  expect(notes.map((note) => note.note)).toEqual(texts);
};

const noteRoutesSuite = (kind: NoteKind): void => {
  describeWithEnv(`admin > ${kind.label} notes routes`, { db: true }, () => {
    test("GET renders the add-note form for an existing record", async () => {
      const { id } = await kind.create("What size?");
      const response = await adminGet(kind.notePath(id));
      expect(response.status).toBe(200);
      const html = await response.text();
      assertStringIncludes(html, `action="${kind.notePath(id)}"`);
      assertStringIncludes(html, 'name="note"');
    });

    test("GET on a missing record is a 404", async () => {
      const missing = kind.notePath(999999);
      const response = await adminGet(missing);
      expect(response.status).toBe(404);
    });

    test("POST creates an owner note and returns to the record page", async () => {
      const { id } = await kind.create("Noted record");
      const { response } = await adminFormPost(kind.notePath(id), {
        note: "Check the wording before the season",
      });
      expectRedirectWithFlash(
        kind.pagePath(id),
        t("notes.added"),
        true,
      )(response);

      await expectNotes(kind, id, ["Check the wording before the season"]);
    });

    test("keeps notes from an editor, the staff floor the routes declare", async () => {
      const { id } = await kind.create("Editor refused");
      const { cookie } = await createTestEditorSession();
      const response = await postFormAs(kind.notePath(id), cookie, {
        note: "from the editor",
      });
      expect(response.status).toBe(403);
      expect(await getNoteRows(kind.entity, [id])).toEqual([]);

      // The record page hides the notes block and the add-note link from the
      // editor too: the banner cannot decrypt, so it must not promise a form
      // the routes would refuse.
      const page = await awaitTestRequest(kind.pagePath(id), { cookie });
      expect(page.status).toBe(200);
      const html = await page.text();
      assert(!html.includes("Add a note"));
      assert(!html.includes(kind.notePath(id)));
    });

    test("POST with a blank note re-renders the form with an error and saves nothing", async () => {
      const { id } = await kind.create("Blank note");
      const { response } = await adminFormPost(kind.notePath(id), {
        note: "   ",
      });
      expect(response.status).toBe(400);
      assertStringIncludes(await response.text(), "Enter a note");
      expect(await getNoteRows(kind.entity, [id])).toEqual([]);
    });

    test("POST on a missing record is a 404", async () => {
      const { response } = await adminFormPost(kind.notePath(999999), {
        note: "orphan",
      });
      expect(response.status).toBe(404);
    });

    test("GET renders the are-you-sure delete page for a note", async () => {
      const { id } = await kind.create("Deletable note");
      await adminFormPost(kind.notePath(id), { note: "deletable" });
      const [row] = await getNoteRows(kind.entity, [id]);

      const response = await adminGet(`${kind.notePath(id)}/${row!.id}/delete`);
      expect(response.status).toBe(200);
      const html = await response.text();
      assertStringIncludes(html, "Are you sure");
      assertStringIncludes(html, "deletable");
      // The intermediate page never asks for the copy/paste confirmation.
      assert(!html.includes('name="confirm_identifier"'));
    });

    test("GET delete on a missing note is a 404", async () => {
      const { id } = await kind.create("Missing note");
      const response = await adminGet(`${kind.notePath(id)}/424242/delete`);
      expect(response.status).toBe(404);
    });

    test("POST delete removes the note and returns to the record page", async () => {
      const { id } = await kind.create("Delete the note");
      await adminFormPost(kind.notePath(id), { note: "to be deleted" });
      const [row] = await getNoteRows(kind.entity, [id]);

      const { response } = await adminFormPost(
        `${kind.notePath(id)}/${row!.id}/delete`,
      );
      expectRedirectWithFlash(
        kind.pagePath(id),
        t("notes.deleted"),
        true,
      )(response);
      expect(await getNoteRows(kind.entity, [id])).toEqual([]);
    });

    test("POST delete on a missing note is a 404", async () => {
      const { id } = await kind.create("Missing note delete");
      const { response } = await adminFormPost(
        `${kind.notePath(id)}/424242/delete`,
      );
      expect(response.status).toBe(404);
    });
  });
};

noteRoutesSuite(groupKind);
noteRoutesSuite(listingKind);
