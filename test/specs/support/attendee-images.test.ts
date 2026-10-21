/**
 * A region check holds one page region to its own copy of a picture. A scan
 * that runs past the region's end swallows a neighbour's raw reference, and
 * the steps can pass without proving anything.
 */

// jscpd:ignore-start
import { describe, it as test } from "@std/testing/bdd";
import { regionShowsPicture } from "#test/specs/support/attendee-images.ts";
import { worldWith } from "#test/specs/support/world.ts";

// jscpd:ignore-end

const poster = { alt: "Poster", filename: "poster.png", id: 12 };
const world = worldWith({ noteImage: { ...poster, noteText: "" } });
const shown = '<img src="/image/poster.png" alt="Poster">';

describe("holding one page region to its own picture", () => {
  test("reads a child of the same kind and stops at the region's own end", () => {
    const html =
      '<div class="contact-notes"><p>Called first.</p>' +
      `<div class="contact-note">a later note</div>${shown}</div>` +
      `<div class="elsewhere">img#${poster.id}</div>`;
    regionShowsPicture(html, '<div class="contact-notes">', "div", world);
  });

  test("starts at the tag a marker inside its attributes names", () => {
    const html =
      '<details class="attendee-notes-summary"><details>inner words</details>' +
      `${shown}</details><details>img#${poster.id}</details>`;
    regionShowsPicture(html, "attendee-notes-summary", "details", world);
  });
});
