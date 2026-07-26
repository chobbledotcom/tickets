import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  rescuingPageSetup,
  soloChildAddOn,
} from "#test/test-utils/listing-parents/helpers.ts";
import { assertJson, expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet, apiRequest } from "#test-utils/session.ts";

const ADDON_ERROR = "opt-in add-on reachable only through";

/** The flash text a rejected orphaning deactivate/delete surfaces. */
const childOnlyAddOnFlash = async (): Promise<string> => {
  const { t } = await import("#i18n");
  return t("modifiers.err_child_only_addon", { name: "Child-scoped extra" });
};

/** Assert a JSON API call is rejected (400) with the orphaned-add-on error. */
const expectApiAddOnError = async (
  request: Promise<Response>,
): Promise<void> => {
  await assertJson<{ error: string }>(request, 400, (json) => {
    expect(json.error).toContain(ADDON_ERROR);
  });
};

/** Assert a listing is still active (an orphaning deactivate was blocked). */
const expectStaysActive = async (id: number): Promise<void> => {
  expect((await getListingWithCount(id))?.active).toBe(true);
};

describeWithEnv(
  "server > listing parents > deactivation & deletion",
  { db: true },
  () => {
    test("deactivating the only active non-child page of a child add-on is rejected", async () => {
      // An opt-in add-on is scoped to {child, thatPage}. The child is suppressed
      // (it has no standalone page), so the add-on is reachable only through
      // `thatPage`. Deactivating `thatPage` — an ordinary listing with NO edges of
      // its own — would leave the add-on reachable only via the suppressed child,
      // a dead end. The deactivation must be rejected, and the listing stay active.
      const { thatPage } = await rescuingPageSetup();
      const { response } = await adminFormPost(
        `/admin/listing/${thatPage.id}/deactivate`,
        { confirm_identifier: thatPage.name },
      );
      response.body?.cancel();
      expect(response.status).toBe(302);
      expectFlash(response, await childOnlyAddOnFlash(), false);
      expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
    });

    test("an admin API edit-save that deactivates the rescuing page is rejected", async () => {
      // The full edit-save path (validateListingInput → validateListingEdges)
      // must also block a deactivation that orphans a child-scoped add-on, not
      // only the dedicated /deactivate route. Set `active: false` via PUT.
      const { thatPage } = await rescuingPageSetup();
      await expectApiAddOnError(
        apiRequest(`/api/admin/listings/${thatPage.id}`, {
          body: { active: false },
          method: "PUT",
        }),
      );
      await expectStaysActive(thatPage.id);
    });

    test("API deactivate of the only rescuing page of a child add-on is rejected, leaving it active", async () => {
      // The JSON API toggle (POST /api/admin/listings/:id/deactivate) must run the
      // same orphaned-add-on guard the HTML deactivate route does: deactivating
      // `thatPage` — the only active non-child page rescuing a {child, thatPage}-
      // scoped opt-in add-on — would leave the add-on reachable only via the
      // suppressed child. The API must reject with a 400 and the listing stay active.
      const { thatPage } = await rescuingPageSetup();
      await expectApiAddOnError(
        apiRequest(`/api/admin/listings/${thatPage.id}/deactivate`, {
          method: "POST",
        }),
      );
      await expectStaysActive(thatPage.id);
    });

    test("API deactivate of a bookable_alone child whose add-on only it can reach is rejected", async () => {
      // A bookable_alone child's OWN page is the sole seller of an add-on scoped
      // only to it. Its stored row still reads bookable_alone=1 during the save, so
      // getNonStandaloneChildIds excludes it from the suppressed set; the
      // deactivation guard must force the flagged child in by hand, or taking its
      // page offline silently orphans the add-on only it could sell.
      const { child } = await soloChildAddOn();
      await expectApiAddOnError(
        apiRequest(`/api/admin/listings/${child.id}`, {
          body: { active: false },
          method: "PUT",
        }),
      );
      await expectStaysActive(child.id);
    });

    test("POST deactivate of a bookable_alone child whose add-on only it can reach is rejected", async () => {
      // The dedicated /deactivate route (deactivationOrphanedAddOnError) must apply
      // the same flagged-child suppression the edit-save path does — a bookable_alone
      // child taken offline here would otherwise silently orphan a child-only add-on.
      const { child } = await soloChildAddOn();
      await expectApiAddOnError(
        apiRequest(`/api/admin/listings/${child.id}/deactivate`, {
          method: "POST",
        }),
      );
      await expectStaysActive(child.id);
    });

    test("API deactivate of a listing unrelated to any child add-on still succeeds", async () => {
      // The guard must not block an ordinary API deactivation: a plain listing
      // rescuing no child-scoped add-on toggles inactive normally.
      const plain = await createTestListing({ name: "Plain" });
      await assertJson(
        apiRequest(`/api/admin/listings/${plain.id}/deactivate`, {
          method: "POST",
        }),
        200,
        (json) => {
          expect(json.listing.active).toBe(false);
        },
      );
      expect((await getListingWithCount(plain.id))?.active).toBe(false);
    });

    test("deactivating a listing unrelated to any child add-on still succeeds", async () => {
      // A plain listing not rescuing any child-scoped add-on deactivates normally
      // — the orphan guard must not block ordinary deactivations.
      const plain = await createTestListing({ name: "Plain" });
      const { response } = await adminFormPost(
        `/admin/listing/${plain.id}/deactivate`,
        { confirm_identifier: plain.name },
      );
      response.body?.cancel();
      expect((await getListingWithCount(plain.id))?.active).toBe(false);
    });

    test("the deactivate confirmation GET renders the orphaned-add-on error and does NOT redirect to itself", async () => {
      // Wiring the orphan guard as a `preValidate` made the confirmation GET
      // redirect to /deactivate (its own URL) in a loop instead of rendering. The
      // fix renders the page (200) WITH the error, and only the POST blocks. Here
      // `thatPage` is the sole rescuer of a {child, thatPage}-scoped add-on.
      const { thatPage } = await rescuingPageSetup();
      const response = await adminGet(
        `/admin/listing/${thatPage.id}/deactivate`,
      );
      const body = await response.text();
      // Renders the confirmation page (200), not a 302 back to itself.
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBe(null);
      expect(body).toContain(await childOnlyAddOnFlash());
      // The listing is untouched by the GET.
      expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
    });

    test("deleting the only rescuing page of a {child, thatPage}-scoped add-on is blocked", async () => {
      // The delete path prunes edges but bypassed the reachability guard the
      // deactivate paths use: deleting `thatPage` (the sole active non-child page
      // of a {child, thatPage}-scoped opt-in add-on) would leave the add-on
      // reachable only via the suppressed child. The HTML delete must block and
      // keep the listing.
      const { thatPage } = await rescuingPageSetup();
      const { response } = await adminFormPost(
        `/admin/listing/${thatPage.id}/delete`,
        { confirm_identifier: thatPage.name },
      );
      response.body?.cancel();
      expectFlash(response, await childOnlyAddOnFlash(), false);
      // The listing is NOT deleted.
      expect(await getListingWithCount(thatPage.id)).not.toBe(null);
    });

    test("the unverified direct delete (verify_identifier=false) is also blocked by the orphan guard", async () => {
      // The direct-delete branch (no typed-identifier confirmation) must run the
      // same guard as the confirmed path: it shares no code with the confirmed
      // handler, so it needs its own block.
      const { thatPage } = await rescuingPageSetup();
      const { response } = await adminFormPost(
        `/admin/listing/${thatPage.id}/delete?verify_identifier=false`,
      );
      response.body?.cancel();
      expectFlash(response, await childOnlyAddOnFlash(), false);
      expect(await getListingWithCount(thatPage.id)).not.toBe(null);
    });

    test("API delete of the only rescuing page of a child add-on is blocked, leaving it", async () => {
      // The admin JSON API delete must run the same guard as the HTML delete.
      const { thatPage } = await rescuingPageSetup();
      await expectApiAddOnError(
        apiRequest(`/api/admin/listings/${thatPage.id}`, {
          body: { confirm_identifier: thatPage.name },
          method: "DELETE",
        }),
      );
      expect(await getListingWithCount(thatPage.id)).not.toBe(null);
    });

    test("deleting a listing unrelated to any child add-on still works", async () => {
      // The guard must not block an ordinary delete.
      const plain = await createTestListing({ name: "Disposable" });
      await assertJson(
        apiRequest(`/api/admin/listings/${plain.id}`, {
          body: { confirm_identifier: plain.name },
          method: "DELETE",
        }),
        200,
        (json) => {
          expect(json.status).toBe("ok");
        },
      );
      expect(await getListingWithCount(plain.id)).toBe(null);
    });
  },
);
