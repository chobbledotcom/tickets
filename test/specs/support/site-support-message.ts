/**
 * A built site's support message: what the operator reads on the site's own
 * tab. The stored message lives on the hosting provider's API, which no story
 * can carry, so the stored value is put where the site reads it — the same
 * way the provider's own tests put theirs — and the watch comes down when the
 * scenario ends.
 */

// jscpd:ignore-start
import { stub } from "@std/testing/mock";
import { supportMessageApi } from "#shared/site-support-message.ts";
import { scenarioEnv, type TicketsWorld } from "#test/specs/support/world.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
// jscpd:ignore-end

/** The tab a site's support message is read and edited on. */
export const supportMessageTab = (siteId: number): string =>
  `/admin/built-sites/${siteId}/support-message`;

/** A built site whose stored support message names a picture, with the
 * picture uploaded and the site remembered for the steps that open its tab. */
export const siteCarriesSupportMessageWithPicture = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  scenarioEnv(world, { BUNNY_API_KEY: "k", CAN_BUILD_SITES: "true" });
  const site = await createTestBuiltSite({
    hostingId: "8200",
    name: "Reader Site",
  });
  const image = await makeImage(name);
  const watch = stub(supportMessageApi, "readSupportMessage", () =>
    Promise.resolve({
      ok: true as const,
      value: `Questions? ![${name}](img#${image.id})`,
    }),
  );
  world.cleanup.add(watch.restore);
  world.things.remember("record", "built site", site.id);
  world.noteImage = {
    alt: name,
    filename: image.filename,
    id: image.id,
    noteText: "",
  };
};

/** The whole site is inside its read-only window, so every panel reads as
 * written and nothing offers to change. */
export const siteIsReadOnly = (world: TicketsWorld): void => {
  scenarioEnv(world, { READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
};
