import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withGuardedListing } from "#routes/api/guards.ts";
import { LISTING_NOT_FOUND } from "#routes/api/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent } from "#test-utils/parents.ts";

/** Call a guarded route for `slug` and answer the response with what the inner
 *  handler saw, or null when the guard stopped the request. */
const guarded = async (
  slug: string,
): Promise<{
  body: unknown;
  seen: { id: number; isSoldOutParent: boolean } | null;
  status: number;
}> => {
  let seen: { id: number; isSoldOutParent: boolean } | null = null;
  const route = withGuardedListing((_request, listing, isSoldOutParent) => {
    seen = { id: listing.id, isSoldOutParent };
    return Promise.resolve(Response.json({ ok: true }));
  });
  const response = await route(new Request("http://localhost"), { slug });
  return { body: await response.json(), seen, status: response.status };
};

describeWithEnv("withGuardedListing", { db: true }, () => {
  test("passes a plain listing through as not sold out", async () => {
    const listing = await createTestListing();
    expect(await guarded(listing.slug)).toEqual({
      body: { ok: true },
      seen: { id: listing.id, isSoldOutParent: false },
      status: 200,
    });
  });

  test("marks a parent with no bookable child as sold out", async () => {
    const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
    expect((await guarded(parent.slug)).seen).toEqual({
      id: parent.id,
      isSoldOutParent: true,
    });
  });

  test("answers 404 for a child listing and skips the handler", async () => {
    const { children } = await makeParent();
    expect(await guarded(children[0]!.slug)).toEqual({
      body: { error: LISTING_NOT_FOUND },
      seen: null,
      status: 404,
    });
  });
});
