import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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

    test("a parent's quantity is clamped to a single child's capacity", async () => {
      // The parent offers up to 5, but its single auto-selected child is capped
      // at 1, so child quantity (slaved to the parent) can only be 1 — the page
      // must offer only quantity 0–1, not 2–5 the submit fold would reject
      // (Codex 565).
      const parent = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 1,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const body = await (await ticketGet(parent.slug)).text();
      const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="1"');
      expect(options).not.toContain('value="2"');
      expect(options).not.toContain('value="5"');
    });

    test("a parent's quantity is clamped to a child capped at three", async () => {
      // With the child capped at 3, the parent offering 5 must offer up to 3 and
      // no higher (Codex 565).
      const parent = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 3,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const body = await (await ticketGet(parent.slug)).text();
      const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="3"');
      expect(options).not.toContain('value="4"');
      expect(options).not.toContain('value="5"');
    });

    test("a parent + child sharing a capped group with 2 spots offers only qty 1", async () => {
      // Parent and its only child share a capped group, so each order consumes
      // TWO group spots (parent + auto-selected child). With two spots free the
      // selector must offer quantity 1 and never 2, which the submit-side
      // combined-demand check would reject (Fix 3, invariant I7).
      const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
      const parent = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const body = await (await ticketGet(parent.slug)).text();
      const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="1"');
      expect(options).not.toContain('value="2"');
    });

    test("a parent + child sharing a capped group with 4 spots offers up to qty 2", async () => {
      // With four shared spots free, two parent+child orders fit (four units), so
      // the selector offers up to quantity 2 and no higher (Fix 3).
      const group = await createTestGroup({ maxAttendees: 4, name: "Pool" });
      const parent = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const body = await (await ticketGet(parent.slug)).text();
      const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="2"');
      expect(options).not.toContain('value="3"');
    });

    test("a group containing a child member still renders (not 404)", async () => {
      // The group page loads members indirectly, so a child member is suppressed
      // /folded — not a reason to 404 the whole group (the buyer isn't starting
      // from the child directly).
      const group = await createTestGroup({ name: "Combo" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);
      const res = await ticketGet(group.slug);
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
