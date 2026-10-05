/**
 * The feed and share-surface share of the listing parent/child discovery
 * rules: RSS/ICS feeds omit a child and a parent with no bookable child, the
 * admin multi-booking builder excludes children, and the per-listing share/QR
 * affordances and routes stay parent-only.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { makeParent } from "#test-utils/parents.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

describeWithEnv(
  "listing parent discovery — feeds and share surfaces",
  { db: true, triggers: true },
  () => {
    describe("RSS/ICS feeds", () => {
      test("omits a child and a no-bookable-child parent, keeps a normal one", async () => {
        const { child } = await makeParent({
          children: [{ name: "FeedChild" }],
          parent: { name: "FeedParent" },
        });
        await deactivateTestListing(child.id);
        const plain = await createTestListing({ name: "FeedPlain" });
        await enablePublicSite();
        const rss = await (
          await handleRequest(mockRequest("/feeds/listings.rss"))
        ).text();
        // Child is inactive (not in feed regardless) and the parent has no
        // bookable child, so the parent is omitted; the plain listing remains.
        expect(rss).not.toContain("FeedParent");
        expect(rss).not.toContain("FeedChild");
        expect(rss).toContain("FeedPlain");
        expect(rss).toContain(`/ticket/${plain.slug}`);
      });

      test("omits a visible child item from the feed", async () => {
        const { child } = await makeParent({
          children: [{ name: "VisChild" }],
          parent: { name: "VisParent" },
        });
        await enablePublicSite();
        const ics = await (
          await handleRequest(mockRequest("/feeds/listings.ics"))
        ).text();
        // Parent is bookable (one available child) so it stays; the child's own
        // standalone item is omitted.
        expect(ics).toContain("VisParent");
        expect(ics).not.toContain(`/ticket/${child.slug}`);
      });
    });

    describe("admin multi-booking link builder", () => {
      test("excludes children from the selectable checkboxes", async () => {
        const { parent, child } = await makeParent({
          children: [{ name: "MbChild" }],
          parent: { name: "MbParent" },
        });
        const plain = await createTestListing({ name: "MbPlain" });
        const body = await (await adminGet("/admin/listings")).text();
        expect(body).toContain(`data-multi-booking-slug="${parent.slug}"`);
        expect(body).toContain(`data-multi-booking-slug="${plain.slug}"`);
        expect(body).not.toContain(`data-multi-booking-slug="${child.slug}"`);
      });
    });

    describe("per-listing share / QR generators", () => {
      test("the child detail page suppresses the share/QR affordances", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const body = await (
          await adminGet(`/admin/listing/${child.id}`)
        ).text();
        expect(body).not.toContain(`/admin/listing/${child.id}/qr`);
        expect(body).not.toContain(`/ticket/${child.slug}/qr`);
        expect(body).toContain(
          "it has no standalone booking link, embed, or QR code",
        );
        // The public booking URL and both embed snippets are suppressed too — a
        // child has no standalone entry point to share or embed.
        expect(body).not.toContain(`/ticket/${child.slug}`);
        expect(body).not.toContain(`embed-toggle-${child.id}`);
        expect(body).not.toContain(`embed-script-${child.id}`);
        expect(body).not.toContain(`embed-iframe-${child.id}`);
      });

      test("a parent detail page keeps its share/QR affordances", async () => {
        const { parent } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const body = await (
          await adminGet(`/admin/listing/${parent.id}`)
        ).text();
        expect(body).toContain(`/admin/listing/${parent.id}/qr`);
        // A non-child parent keeps its public URL and both embed snippets, so the
        // suppression is genuinely conditional on being a child.
        expect(body).toContain(`/ticket/${parent.slug}`);
        expect(body).toContain(`embed-script-${parent.id}`);
        expect(body).toContain(`embed-iframe-${parent.id}`);
      });

      test("the child QR generator route 404s", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const get = await adminGet(`/admin/listing/${child.id}/qr`);
        get.body?.cancel();
        expect(get.status).toBe(404);
        const json = await adminGet(`/admin/listing/${child.id}/qr.json`);
        json.body?.cancel();
        expect(json.status).toBe(404);
      });

      test("the public child QR image route 404s", async () => {
        const { child } = await makeParent({
          children: [{ name: "QrChild" }],
          parent: { name: "QrParent" },
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}/qr`),
        );
        response.body?.cancel();
        expect(response.status).toBe(404);
      });
    });
  },
);
