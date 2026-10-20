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
import { uploadsAPicture } from "#test/specs/support/attendee-images.ts";
import {
  type SeedsOneNamedThing,
  scenarioEnv,
} from "#test/specs/support/world.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
// jscpd:ignore-end

/** The tab a site's support message is read and edited on. */
export const supportMessageTab = (siteId: number): string =>
  `/admin/built-sites/${siteId}/support-message`;

/** A built site whose stored support message names a picture, with the
 * picture uploaded and the site remembered for the steps that open its tab. */
export const siteCarriesSupportMessageWithPicture: SeedsOneNamedThing = async (
  world,
  name,
) => {
  scenarioEnv(world, { BUNNY_API_KEY: "k", CAN_BUILD_SITES: "true" });
  const site = await createTestBuiltSite({
    hostingId: "8200",
    name: "Reader Site",
  });
  const picture = await uploadsAPicture(world, name);
  const watch = stub(supportMessageApi, "readSupportMessage", () =>
    Promise.resolve({
      ok: true as const,
      value: `Questions? ![${name}](img#${picture.id})`,
    }),
  );
  world.cleanup.add(watch.restore);
  world.things.remember("record", "built site", site.id);
};
