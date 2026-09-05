/**
 * A package can conceal its contents on package booking and ticket surfaces.
 * Its members keep their independent listing and booking paths.
 *
 * Sits beside the story `@story:bookings.selling-things-as-one-bundle`: these
 * own the branch cover, and the invariants that have no journey behind them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#db/groups/membership.ts";
import { groups } from "#db/groups.ts";
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

    test("a concealed package member keeps its own booking page", async () => {
      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils/mocks.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "DirectHide",
        slug: "direct-hide",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await member(group, "DirectMember");

      const res = await handleRequest(mockRequest(`/ticket/${listing.slug}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("DirectMember");
    });

    test("a concealed package member keeps its QR booking paths", async () => {
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
      expect(qr.status).toBe(200);
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
      expect(qrBook.status).not.toBe(404);
    });

    test("a regular group shows a shared concealed-package member", async () => {
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
      await member(regular, "OtherMember");

      const res = await handleRequest(mockRequest(`/ticket/${regular.slug}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SharedMember");
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

    test("a concealed package member's admin detail offers share actions", async () => {
      const listing = await hiddenPackageMember("HideShare");
      const body = await (
        await adminGet(`/admin/listing/${listing.id}`)
      ).text();
      expect(body).toContain(`/admin/listing/${listing.id}/qr`);
      expect(body).toContain(`/ticket/${listing.slug}`);
      expect(body).toContain(`embed-script-${listing.id}`);
      expect(body).toContain(`embed-iframe-${listing.id}`);
    });

    test("a concealed package member's admin QR generator serves", async () => {
      const listing = await hiddenPackageMember("HideQr");
      const res = await adminGet(`/admin/listing/${listing.id}/qr`);
      expect(res.status).toBe(200);
      await res.body?.cancel();
      const json = await adminGet(`/admin/listing/${listing.id}/qr.json`);
      expect(json.status).toBe(200);
      await json.body?.cancel();
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

    test("a regular group can share a concealed-package member", async () => {
      const pkg = await createTestGroup({ isPackage: true, name: "HideOnly" });
      await groups.table.update(pkg.id, { hidePackageListings: true });
      const shared = await member(pkg, "Hidden Shared Member");
      const regular = await createTestGroup({
        name: "RegularEmpty",
        slug: "regular-empty",
      });
      await assignListingsToGroup([shared.id], regular.id);

      const html = await (await adminGet(`/admin/groups/${regular.id}`)).text();
      expect(html).toContain(`/ticket/${regular.slug}`);
    });
  },
);
