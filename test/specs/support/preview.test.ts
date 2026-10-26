/**
 * The preview journey names the editor as its actor, so the preview is posted
 * from an editor's own session. A journey that rode the owner's session would
 * pass even after editor access changed, proving nothing about the actor it
 * names — that is what is pinned here.
 */

// jscpd:ignore-start
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptAdminLevel, getAllUsers } from "#db/users.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";
import { namedThings } from "#test/specs/support/memory.ts";
import { PREVIEWER, previewsText } from "#test/specs/support/preview.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
  worldWith,
} from "#test/specs/support/world.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

/** The Feature whose actor the journey acts out. */
const FEATURE = "specs/pages/previewing-formatted-text.feature";

/** The actors the story declares, through the same checked catalog the spec
 * runner uses. */
const declaredActors = async (): Promise<string[]> => {
  const catalog = await readSpecCatalog([FEATURE]);
  const [story] = catalog.stories;
  if (!story) throw new Error(`The catalog parsed no story from ${FEATURE}`);
  return story.actors;
};

/** The Feature must still name the editor. The journey test holds the rows to
 * the same actor, so the tag and the session change together or not at all. */
describe("the preview story's declared actor", () => {
  test("the story names the editor", async () => {
    expect(await declaredActors()).toContain("editor");
  });
});

describeWithEnv("the preview journey's actor", { db: true }, () => {
  test("the editor's own session drives the preview", async () => {
    const world: TicketsWorld = worldWith({ things: namedThings() });

    await previewsText(world, "# Hello");

    assertStringIncludes(whatTheyWereTold(world, PREVIEWER), "<h1>Hello</h1>");
    const levels = await Promise.all(
      (await getAllUsers()).map((user) => decryptAdminLevel(user)),
    );
    expect(levels).toContain("editor");
  });
});
