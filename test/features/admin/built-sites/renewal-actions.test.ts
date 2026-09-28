import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites, updateBuiltSiteRenewalState } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  renewalSuiteHelpers,
  secretNamesOf,
  siteAction,
} from "./renewal-setup.ts";

const NOW_MS = 1_700_000_000_000;

const findSite = async (siteId: number): Promise<BuiltSite> =>
  (await builtSites.getAll()).find((s) => s.id === siteId)!;

/** Assert bump-deadline clamps `months` to `expectedMonths` (under fake time). */
const expectBumpClamps = async (
  scriptId: string,
  siteName: string,
  months: string,
  expectedMonths: number,
): Promise<void> => {
  using _fakeTime = new FakeTime(NOW_MS);
  const site = await createTestBuiltSite({
    hostingId: scriptId,
    name: siteName,
  });
  const { response } = await siteAction(site, "bump-deadline", { months });
  expect(response.status).toBe(302);
  const updated = await findSite(site.id);
  expect(updated.readOnlyFrom).toBe(
    addMonthsIso(new Date(NOW_MS).toISOString(), expectedMonths),
  );
};

describeWithEnv(
  "admin built-sites renewal actions",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = renewalSuiteHelpers();

    /** Assert override-deadline rejects `date` without changing state or pushing. */
    const expectOverrideRejected = async (
      scriptId: string,
      siteName: string,
      date: string,
    ): Promise<void> => {
      const site = await createTestBuiltSite({
        hostingId: scriptId,
        name: siteName,
      });
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });
      const { response } = await siteAction(site, "override-deadline", {
        date,
      });
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/renewal`,
        "Choose a valid deadline date",
        false,
      )(response);
      const updated = await findSite(site.id);
      expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      expect(suite.secretStub.calls.length).toBe(0);
    };
    describe("POST /admin/built-sites/:id/rotate-renewal-token", () => {
      test("refuses to rotate while the token is reserved unconfirmed", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6044",
          name: "Reserved Not Confirmed",
        });
        // Reserve the token with the cutoff left empty — the state the
        // assignment recovery is re-pushing right now.
        await provisionTestBuiltSite(site.id, { readOnlyFrom: "" });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal is not provisioned for this site",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("");
      });

      test("rotates token on a provisioned site and pushes new RENEWAL_URL", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6001",
          name: "Rotate Site",
        });
        const { token: oldToken } = await provisionTestBuiltSite(site.id);

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal token rotated",
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalToken).not.toBe(oldToken);
        expect(updated.renewalToken).not.toBeNull();
        expect(updated.renewalTokenIndex).not.toBeNull();

        // Rotate only re-pushes RENEWAL_URL, not READ_ONLY_FROM.
        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).toContain("RENEWAL_URL");
        expect(secretNames).not.toContain("READ_ONLY_FROM");

        const logs = await getAllActivityLog();
        expect(
          logs.some((l) => l.message.includes("Rotated renewal token")),
        ).toBe(true);
      });

      test("redirects on unprovisioned site (no-op)", async () => {
        const site = await createTestBuiltSite({
          name: "Unprovisioned Rotate",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal is not provisioned for this site",
          false,
        )(response);

        expect(suite.secretStub.calls.length).toBe(0);
      });

      test("shows the exact error when the replacement token cannot be pushed", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6002",
          name: "Rotate Failure",
        });
        await provisionTestBuiltSite(site.id);

        await suite.withFailingSecretStub(async () => {
          const { response } = await siteAction(site, "rotate-renewal-token");
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/renewal`,
            "Renewal token could not be pushed to the site",
            false,
          )(response);
        });
      });
    });

    describe("POST /admin/built-sites/:id/bump-deadline", () => {
      test("bumps from current deadline on future-dated site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6010",
          name: "Bump Future",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS + 10 * 86400000).toISOString(),
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Deadline bumped",
        )(response);

        const updated = await findSite(site.id);
        const expectedBase = new Date(NOW_MS + 10 * 86400000).toISOString();
        expect(updated.readOnlyFrom).toBe(addMonthsIso(expectedBase, 3));
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin bumped 'Bump Future' deadline by 3 month(s)");
      });

      test("bumps from now on expired site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6011",
          name: "Bump Expired",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: new Date(NOW_MS - 30 * 86400000).toISOString(),
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "6",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 6);
        expect(updated.readOnlyFrom).toBe(expected);
      });

      test("bumps from now on deadline-less site", async () => {
        using _fakeTime = new FakeTime(NOW_MS);
        const site = await createTestBuiltSite({
          hostingId: "6012",
          name: "Bump No Deadline",
        });

        await adminFormPost(`/admin/built-sites/${site.id}/bump-deadline`, {
          months: "2",
        });

        const updated = await findSite(site.id);
        const expected = addMonthsIso(new Date(NOW_MS).toISOString(), 2);
        expect(updated.readOnlyFrom).toBe(expected);
      });

      test("works without a renewal token (no RENEWAL_URL push)", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6013",
          name: "Bump No Token",
        });
        suite.resetSecretStub();

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/bump-deadline`,
          { months: "1" },
        );
        expect(response.status).toBe(302);

        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).not.toContain("RENEWAL_URL");
      });

      test("clamps months <= 0 to 1", () =>
        expectBumpClamps("6014", "Bump Zero", "0", 1));

      test("clamps months > 120 to 120", () =>
        expectBumpClamps("6015", "Bump Large", "999", 120));

      test("returns error when CDN push fails", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6016",
          name: "Bump CDN Fail",
        });
        await suite.withFailingSecretStub(async () => {
          const { response } = await adminFormPost(
            `/admin/built-sites/${site.id}/bump-deadline`,
            { months: "1" },
          );
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/renewal`,
            expect.stringContaining("could not be pushed"),
            false,
          )(response);
        });
      });

      test("clamps non-numeric months to 1", () =>
        expectBumpClamps("6017", "Bump NaN", "abc", 1));

      test("treats a hexadecimal month value as zero", () =>
        expectBumpClamps("6018", "Bump Hex", "0x10", 1));
    });

    describe("POST /admin/built-sites/:id/override-deadline", () => {
      test("accepts a future date and pushes it", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6020",
          name: "Override Site",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
          { date: "2027-06-15" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Deadline updated",
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("2027-06-15T23:59:59Z");
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain(
          "Admin overrode 'Override Site' deadline to 2027-06-15T23:59:59Z",
        );
      });

      test("works without a renewal token", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6021",
          name: "Override No Token",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
          { date: "2027-12-01" },
        );
        expect(response.status).toBe(302);

        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).not.toContain("RENEWAL_URL");
      });

      test("redirects when date is missing", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6022",
          name: "Override Empty",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: "2027-01-01T00:00:00Z",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Choose a deadline date",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      });

      test("rejects an invalid date without pushing", () =>
        expectOverrideRejected("6023", "Override Invalid", "2027-02-31"));

      test("rejects a non-date-format string without pushing", () =>
        expectOverrideRejected("6024", "Override Not Date", "hello"));
    });
  },
);
