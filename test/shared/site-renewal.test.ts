import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#crypto/hashing.ts";
import {
  builtSites,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import {
  parseReadOnlyFromMs,
  provisionSiteRenewal,
  renewalDeadlineBaseMs,
  rotateRenewalToken,
  syncReadOnlyFrom,
} from "#shared/site-renewal.ts";
import { recordingRenewalUrlPush } from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { assignmentEntry } from "./site-assignment/contracts-setup.ts";

describe("renewal secret pushes", () => {
  test("returns an exact missing-hosting-id error", async () => {
    const result = await syncReadOnlyFrom(
      testBuiltSite({ hostingId: "" }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(result).toEqual({ error: "No hostingId", ok: false });
  });
});

describeWithEnv("renewal token reservation", { db: true }, () => {
  test("two concurrent provisions push one reserved token", async () => {
    const recorder = recordingRenewalUrlPush();
    using _recording = recorder.stub;
    await insertBuiltSite("Racy site", "racy.test", "", "", false, "77");
    const site = (await builtSites.getAll()).find(
      ({ name }) => name === "Racy site",
    )!;

    await Promise.all([
      provisionSiteRenewal(site, 3, "Provision one failed"),
      provisionSiteRenewal(site, 3, "Provision two failed"),
    ]);

    const stored = (await builtSites.getAll()).find(
      ({ name }) => name === "Racy site",
    )!;
    expect(stored.readOnlyFrom).not.toBe("");
    expect(recorder.pushedUrls.length).toBeGreaterThanOrEqual(1);
    for (const pushed of recorder.pushedUrls) {
      expect(pushed).toContain(stored.renewalToken!);
    }
  });

  test("replaces an orphaned token that carries no index", async () => {
    // A token without its index is dead — no renewal link can resolve it —
    // so the reservation mints a complete, indexed pair in its place.
    await insertBuiltSite("Half Pair", "half.test", "", "", false, "79");
    const site = (await builtSites.getAll()).find(
      ({ name }) => name === "Half Pair",
    )!;
    await updateBuiltSiteRenewalState(site.id, { renewalToken: "dead-token" });

    using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ ok: true as const }),
    );
    const result = await provisionSiteRenewal(site, 3, "Half pair failed");

    const stored = (await builtSites.getAll()).find(
      ({ name }) => name === "Half Pair",
    )!;
    expect(result.pushOk).toBe(true);
    expect(stored.renewalToken).not.toBe("dead-token");
    expect(stored.renewalTokenIndex).toBe(await hmacHash(stored.renewalToken!));
  });

  test("a failed push keeps the reserved token for the retry", async () => {
    let pushesSucceed = false;
    using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve(
        pushesSucceed
          ? { ok: true as const }
          : { error: "push failed", ok: false as const },
      ),
    );
    await insertBuiltSite("Retry site", "retry.test", "", "", false, "78");
    const site = (await builtSites.getAll()).find(
      ({ name }) => name === "Retry site",
    )!;

    const failed = await provisionSiteRenewal(site, 3, "First push failed");
    expect(failed.pushOk).toBe(false);
    const reserved = (await builtSites.getAll()).find(
      ({ name }) => name === "Retry site",
    )!;
    expect(reserved.renewalTokenIndex).not.toBeNull();
    expect(reserved.readOnlyFrom).toBe("");
    const reservedToken = reserved.renewalToken;
    pushesSucceed = true;

    const retried = await provisionSiteRenewal(site, 3, "Retry failed");
    expect(retried.pushOk).toBe(true);
    const confirmed = (await builtSites.getAll()).find(
      ({ name }) => name === "Retry site",
    )!;
    // The retry confirms the reserved token; it never mints a second one.
    expect(confirmed.renewalToken).toBe(reservedToken);
    expect(confirmed.readOnlyFrom).not.toBe("");
  });
});

describe("renewal deadline helpers", () => {
  test("uses the Unix epoch as the empty deadline base at the epoch", () => {
    using _time = new FakeTime(0);

    expect(renewalDeadlineBaseMs({ readOnlyFrom: "" })).toBe(0);
  });

  test("parses a stored read-only deadline", () => {
    const deadline = "2035-06-07T08:09:10.000Z";
    expect(parseReadOnlyFromMs({ readOnlyFrom: deadline })).toBe(
      Date.parse(deadline),
    );
  });
});

describeWithEnv(
  "site renewal push contracts",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("persists a successfully pushed read-only deadline", async () => {
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const cutoff = "2099-04-05T06:07:08.000Z";
      const renewalUrl = "https://example.test/renew/?t=renewal-token";
      await insertBuiltSite(
        "Persistent cutoff",
        "cutoff.test",
        "",
        "",
        false,
        "42",
      );
      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Persistent cutoff",
      )!;

      expect(await syncReadOnlyFrom(site, cutoff, renewalUrl)).toEqual({
        ok: true,
      });
      expect(_secret.calls.map(({ args }) => [args[1], args[2]])).toEqual([
        ["RENEWAL_URL", renewalUrl],
        ["READ_ONLY_FROM", cutoff],
      ]);
      const stored = (await builtSites.getAll()).find(
        ({ name }) => name === "Persistent cutoff",
      )!;
      expect(stored.readOnlyFrom).toBe(cutoff);
    });

    test("provisions renewal state when assigning a site", async () => {
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
      });
      await insertBuiltSite(
        "Renewable site",
        "renewable.test",
        "",
        "",
        true,
        "43",
      );
      using _time = new FakeTime("2030-01-15T12:00:00.000Z");

      await assignAndNotifyBuiltSites([assignmentEntry()]);

      const site = (await builtSites.getAll()).find(
        ({ name }) => name === "Renewable site",
      )!;
      expect(site).toMatchObject({
        assignedAttendeeId: 81,
        assignedListingId: 71,
        readOnlyFrom: "2030-04-15T12:00:00.000Z",
      });
      const token = site.renewalToken;
      if (token === null) throw new Error("renewal token was not saved");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(site.renewalTokenIndex).toBe(await hmacHash(token));
    });

    test("reports a failed renewal push to ntfy", async () => {
      using _env = withEnv({ NTFY_URL: "https://ntfy.test/site-errors" });
      using fetchStub = stubFetch(new Response());
      using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({
          error: "provider rejected secret",
          ok: false as const,
        }),
      );
      using _error = stub(console, "error", () => {});

      const result = await rotateRenewalToken(
        testBuiltSite({ hostingId: "42" }),
        "Token rotation failed",
      );

      expect(result.pushOk).toBe(false);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fetchStub.calls.map(({ args }) => args[1].body)).toEqual([
        "CDN_REQUEST",
      ]);
    });
  },
);
