/**
 * A region check holds one page region to its own copy of a picture. A scan
 * that runs past the region's end swallows a neighbour's raw reference, and
 * the steps can pass without proving anything.
 *
 * The seed helpers drive the real forms, so the tests here also hold them to
 * the note row, the picture, and the addresses they hand the story.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getNoteRows } from "#db/notes/queries.ts";
import {
  noteDeletePath,
  notedAboutWithPicture,
  pageShowsPicture,
  pictureCount,
  regionShowsPicture,
  uploadsAPicture,
} from "#test/specs/support/attendee-images.ts";
import { namedThings } from "#test/specs/support/memory.ts";
import { type TicketsWorld, worldWith } from "#test/specs/support/world.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

const poster = { alt: "Poster", filename: "poster.png", id: 12 };
const worldWithPicture = (): TicketsWorld =>
  worldWith({ noteImage: { ...poster, noteText: "" } });
const shown = '<img src="/image/poster.png" alt="Poster">';

/** Holds the region check to its loud failure on a page with no whole region. */
const expectRegionCheckToThrow = (
  html: string,
  marker: string,
  world: TicketsWorld,
): void =>
  expect(() => regionShowsPicture(html, marker, "div", world)).toThrow();

describe("holding one page region to its own picture", () => {
  test("reads a child of the same kind and stops at the region's own end", () => {
    const html =
      '<div class="contact-notes"><p>Called first.</p>' +
      `<div class="contact-note">a later note</div>${shown}</div>` +
      `<div class="elsewhere">img#${poster.id}</div>`;
    regionShowsPicture(
      html,
      '<div class="contact-notes">',
      "div",
      worldWithPicture(),
    );
  });

  test("starts at the tag a marker inside its attributes names", () => {
    const html =
      '<details class="attendee-notes-summary"><details>inner words</details>' +
      `${shown}</details><details>img#${poster.id}</details>`;
    regionShowsPicture(
      html,
      "attendee-notes-summary",
      "details",
      worldWithPicture(),
    );
  });

  test("skips a longer tag's name to find the region's own opening tag", () => {
    const html = `<div class="region"><divider-notes title="contact-notes">decoy</divider-notes>${shown}</div>`;
    regionShowsPicture(html, "contact-notes", "div", worldWithPicture());
  });

  test("fails loudly when the marker names nothing on the page", () => {
    expectRegionCheckToThrow(
      shown,
      "attendee-notes-summary",
      worldWithPicture(),
    );
  });

  test("fails loudly when no real opening tag holds the marker", () => {
    const html =
      `<divider-notes title="contact-notes">decoy</divider-notes>` +
      `<div class="contact-notes">${shown}</div>`;
    expectRegionCheckToThrow(html, "contact-notes", worldWithPicture());
  });

  test("fails loudly when the page ends inside the opening tag", () => {
    expectRegionCheckToThrow("<div", "div", worldWithPicture());
  });

  test("fails loudly when the region's own tag never closes", () => {
    const html = `<div class="contact-notes"><p>words</p>${shown}`;
    expectRegionCheckToThrow(html, "contact-notes", worldWithPicture());
  });
});

describe("holding the page as a whole to its picture", () => {
  test("passes when the picture shows and no reference stays", () => {
    pageShowsPicture(`<main><p>words</p>${shown}</main>`, worldWithPicture());
  });

  test("fails loudly when a raw reference stays anywhere on the page", () => {
    expect(() =>
      pageShowsPicture(
        `${shown}<p>see img#${poster.id}</p>`,
        worldWithPicture(),
      ),
    ).toThrow();
  });

  test("fails loudly when the picture never shows", () => {
    expect(() =>
      pageShowsPicture("<main><p>words</p></main>", worldWithPicture()),
    ).toThrow();
  });
});

describe("counting the copies the page shows", () => {
  test("counts one copy once", () => {
    expect(
      pictureCount(`<main><p>words</p>${shown}</main>`, worldWithPicture()),
    ).toBe(1);
  });

  test("counts every copy a page that repeats the note holds", () => {
    expect(pictureCount(`${shown}${shown}`, worldWithPicture())).toBe(2);
  });

  test("counts nothing on a page that shows no picture", () => {
    expect(pictureCount("<main><p>words</p></main>", worldWithPicture())).toBe(
      0,
    );
  });
});

describeWithEnv("seeding the note a story tells", { db: true }, () => {
  test("uploads the picture the story named and keeps it in the world", async () => {
    const world = worldWith({});
    const picture = await uploadsAPicture(world, "Poster");
    expect(picture.alt).toBe("Poster");
    expect(picture.filename).toBe("poster.webp");
    expect(picture.noteText).toBe("");
    expect(picture.id).toBeGreaterThan(0);
    expect(world.noteImage).toBe(picture);
  });

  test("books someone and saves the note through the real form", async () => {
    const world = worldWith({ things: namedThings() });
    await notedAboutWithPicture(world, "Ada", "Called about parking", "Poster");
    const note = world.noteImage!;
    expect(note.alt).toBe("Poster");
    expect(note.noteText).toBe(
      `Called about parking ![Poster](img#${note.id})`,
    );
    const [row] = await getNoteRows("attendee", [world.attendeeId!]);
    expect(row!.id).toBe(note.noteId);
  });

  test("gives the saved note's own delete address", () => {
    const world = worldWith({
      attendeeId: 9,
      noteImage: { ...poster, noteId: 33, noteText: "Remove me" },
    });
    expect(noteDeletePath(world)).toBe("/admin/attendee/9/note/33/delete");
  });

  test("fails loudly when no note was saved", () => {
    expect(() => noteDeletePath(worldWith({ attendeeId: 9 }))).toThrow();
  });
});
