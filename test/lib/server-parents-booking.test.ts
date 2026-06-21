import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/** GET a `/ticket/<slugs>` booking page. */
const ticketGet = async (slugs: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
    new Request(`http://localhost/ticket/${slugs}`, {
      headers: { host: "localhost" },
    }),
  );
};

describeWithEnv(
  "server > parents booking gate (flag on)",
  { db: true, env: { LISTING_PARENTS_ENABLED: "true" }, triggers: true },
  () => {
    test("a child slug cannot start a booking (404)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(404);
    });

    test("a parent slug still renders its booking page", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(parent.slug);
      expect(res.status).toBe(200);
    });

    test("a child mixed into a multi-slug URL rejects the whole request", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const other = await createTestListing({ name: "Unrelated" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(`${child.slug}+${other.slug}`);
      expect(res.status).toBe(404);
    });

    test("an ordinary (non-child) listing is unaffected", async () => {
      const listing = await createTestListing({ name: "Plain" });
      const res = await ticketGet(listing.slug);
      expect(res.status).toBe(200);
    });

    test("a signed QR for a child is rejected", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const { handleRequest } = await import("#routes");
      const token = await signQrBookToken(
        child.slug,
        buildQrBookPayload({ name: "Ada" }),
      );
      const res = await handleRequest(
        new Request(
          `http://localhost/ticket/${child.slug}/qr-book?t=${encodeURIComponent(
            token,
          )}`,
          { headers: { host: "localhost" } },
        ),
      );
      expect(res.status).toBe(404);
    });

    test("the JSON API rejects booking a child slug", async () => {
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicApi(true);
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const { handleRequest } = await import("#routes");
      const res = await handleRequest(
        new Request(`http://localhost/api/listings/${child.slug}/book`, {
          body: JSON.stringify({ email: "a@b.com", name: "Ada", quantity: 1 }),
          headers: { "content-type": "application/json", host: "localhost" },
          method: "POST",
        }),
      );
      expect(res.status).toBe(400);
    });
  },
);

describeWithEnv(
  "server > parents booking gate (flag off)",
  { db: true },
  () => {
    test("a child slug still books normally when the flag is off", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(child.slug);
      expect(res.status).toBe(200);
    });
  },
);
