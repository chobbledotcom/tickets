/**
 * A package sold by its own name alone. Nothing it holds may be reached or
 * advertised on its own — not its page, not its QR code, not a share link on
 * the organiser's own screens.
 *
 * Sits beside the story `@story:bookings.selling-things-as-one-bundle`: these
 * own the branch cover, and the invariants that have no journey behind them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import { groups } from "#shared/db/groups.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
// jscpd:ignore-start
import { adminGet } from "#test-utils/session.ts";
import { hiddenPackageMember, member } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server (admin group packages) — a package that hides what is inside",
  { db: true },
  () => {
    test("the hidden package booking page does not expose its single member", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "HiddenPage",
        slug: "hidden-page",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      await member(group, "SecretMember", { location: "SecretVenue" });

      const body = await (
        await handleRequest(mockRequest(`/ticket/${group.slug}`))
      ).text();
      // The page renders (as a package), but the lone member's name/location are
      // not leaked in the header/OpenGraph (singleListing is dropped when hidden).
      expect(body).toContain("HiddenPage");
      expect(body).not.toContain("SecretMember");
      expect(body).not.toContain("SecretVenue");
    });

    test("a hidden package member's own /ticket slug 404s, never a standalone page", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "DirectHide",
        slug: "direct-hide",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await member(group, "DirectMember");

      // Only the package (group slug) is public; the member's own slug must not
      // resolve to a standalone booking page.
      const res = await handleRequest(mockRequest(`/ticket/${listing.slug}`));
      expect(res.status).toBe(404);
    });

    test("a hidden package member's QR and qr-book 404 like its page", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "QrHide",
        slug: "qr-hide",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await member(group, "QrMember");

      const qr = await handleRequest(mockRequest(`/ticket/${listing.slug}/qr`));
      expect(qr.status).toBe(404);
      // A validly-signed qr-book token for the member is still rejected — a
      // hidden member is never bookable on its own, even direct-to-checkout.
      const { buildQrBookPayload, signQrBookToken } = await import(
        "#shared/qr-token.ts"
      );
      const token = await signQrBookToken(
        listing.slug,
        buildQrBookPayload({ name: "Ada", value: 1000 }),
      );
      const qrBook = await handleRequest(
        mockRequest(
          `/ticket/${listing.slug}/qr-book?t=${encodeURIComponent(token)}`,
        ),
      );
      expect(qrBook.status).toBe(404);
    });

    test("a non-package group never exposes a hidden package's members", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const pkg = await createTestGroup({
        isPackage: true,
        name: "HidePkg",
        slug: "hide-pkg",
      });
      await groups.table.update(pkg.id, { hidePackageListings: true });
      const regular = await createTestGroup({
        name: "Regular",
        slug: "regular",
      });
      // A listing shared between the hidden package and a regular public group.
      await createTestListing({
        groupIds: [pkg.id, regular.id],
        name: "SharedMember",
      });

      // The regular group's page must not show the member; with no other member
      // it has nothing to book and 404s rather than leaking it.
      const res = await handleRequest(mockRequest(`/ticket/${regular.slug}`));
      expect(res.status).toBe(404);
    });

    test("a direct /ticket/<package> URL 404s once a member is deactivated", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Bundle",
        slug: "bundle",
      });
      await member(group, "First");
      const second = await member(group, "Second");

      // The complete bundle renders.
      const before = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(before.status).toBe(200);

      // Deactivating one member makes the all-or-nothing bundle incomplete, so the
      // saved/direct URL must 404 rather than sell the active subset — matching how
      // /listings and the group QR already hide it.
      await deactivateTestListing(second.id);
      const after = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(after.status).toBe(404);
    });

    test("a hidden package member's admin detail suppresses share/QR affordances", async () => {
      const listing = await hiddenPackageMember("HideShare");
      const body = await (
        await adminGet(`/admin/listing/${listing.id}`)
      ).text();
      expect(body).not.toContain(`/admin/listing/${listing.id}/qr`);
      expect(body).not.toContain(`/ticket/${listing.slug}`);
      expect(body).toContain("buyers book it only through the package");
      expect(body).not.toContain(`embed-script-${listing.id}`);
      expect(body).not.toContain(`embed-iframe-${listing.id}`);
    });

    test("a hidden package member's admin QR generator route 404s", async () => {
      const listing = await hiddenPackageMember("HideQr");
      const res = await adminGet(`/admin/listing/${listing.id}/qr`);
      res.body?.cancel();
      expect(res.status).toBe(404);
      const json = await adminGet(`/admin/listing/${listing.id}/qr.json`);
      json.body?.cancel();
      expect(json.status).toBe(404);
    });

    test("a package's admin share links are gated on bookability", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "ShareGate",
      });
      const only = await member(group, "Only Member");

      // Bookable bundle: the admin detail offers the public link.
      const before = await (await adminGet(`/admin/groups/${group.id}`)).text();
      expect(before).toContain(`/ticket/${group.slug}`);

      // Deactivating the sole member makes the bundle unbookable, so /ticket/<group>
      // now 404s and the admin share/QR/embed links are suppressed.
      await deactivateTestListing(only.id);
      const after = await (await adminGet(`/admin/groups/${group.id}`)).text();
      expect(after).not.toContain(`/ticket/${group.slug}`);
      expect(after).toContain("isn't currently bookable");
    });

    test("a regular group whose only members are hidden-package members offers no share links", async () => {
      // The member belongs to a hidden package AND a regular group. The public
      // /ticket/<regular> drops the hidden member, leaving an empty visible set, so
      // it 404s — the admin detail must not advertise that dead link.
      const pkg = await createTestGroup({ isPackage: true, name: "HideOnly" });
      await groups.table.update(pkg.id, { hidePackageListings: true });
      const shared = await member(pkg, "Hidden Shared Member");
      const regular = await createTestGroup({
        name: "RegularEmpty",
        slug: "regular-empty",
      });
      await assignListingsToGroup([shared.id], regular.id);

      const html = await (await adminGet(`/admin/groups/${regular.id}`)).text();
      expect(html).not.toContain(`/ticket/${regular.slug}`);
      expect(html).toContain("isn't currently bookable");
    });
  },
);
