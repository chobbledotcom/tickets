/**
 * A failed request to a concealed package's booking API must not confirm a
 * member or child relationship: every client refusal reads one generic
 * message, so probes cannot distinguish a real member from a guess. Named
 * packages keep their specific responses.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { settings } from "#db/settings.ts";
import { apiBookPackage } from "#test/features/api/packages/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The generic refusal every failed client request reads on a concealed
 * package: no probe may distinguish a real member or child from a guess. */
const REFUSED = "This package cannot be booked with those choices.";

describeWithEnv("concealed package API privacy", { db: true }, () => {
  const concealedKit = async () => {
    await settings.update.showPublicApi(true);
    const group = await createHiddenPackageGroup("Probe Box");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Probe Member",
      unitPrice: 500,
    });
    const child = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Probe Addon",
      unitPrice: 100,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 500, quantity: 2 },
    ]);
    return { child, group, member };
  };

  for (const parent of ["probe-member", "not-a-member"]) {
    test(`a child guess on a ${parent === "not-a-member" ? "guessed" : "real"} member reads the generic refusal`, async () => {
      const { child, group } = await concealedKit();
      const { body, response } = await apiBookPackage(group.slug, {
        children: [{ parent, quantity: 1, slug: child.slug }],
      });
      expect(response.status).toBe(400);
      expect(body).toEqual({ error: REFUSED });
    });
  }

  for (const slug of ["probe-addon", "no-such-addon"]) {
    test(`a ${slug === "no-such-addon" ? "guessed" : "real"} child under a bad total reads the generic refusal`, async () => {
      const { group, member } = await concealedKit();
      const { body, response } = await apiBookPackage(group.slug, {
        children: [{ parent: member.slug, quantity: 1, slug }],
      });
      expect(response.status).toBe(400);
      expect(body).toEqual({ error: REFUSED });
    });
  }

  test("a real relationship with missing contact fields reads the generic refusal", async () => {
    const { child, group, member } = await concealedKit();
    const { body, response } = await apiBookPackage(
      group.slug,
      {},
      JSON.stringify({
        children: [{ parent: member.slug, quantity: 2, slug: child.slug }],
        name: "No Email",
      }),
    );
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: REFUSED });
  });
});
