import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import {
  ensureBuiltSiteSchedulerNextKey,
  readBuiltSiteScheduler,
} from "#shared/db/built-site-scheduler.ts";
import {
  builtSitesCrudTable,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import {
  promoteSiteSchedulerRotation,
  provisionSiteScheduler,
  stageSiteSchedulerRotation,
} from "#shared/site-scheduler.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";
import {
  insertScheduledTestSite,
  stubBunnySchedulerSecrets,
} from "#test-utils/scheduled.ts";

describeWithEnv(
  "built-site scheduler provisioning",
  { db: true, env: { BUNNY_API_KEY: "test-key" } },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

    const site = () => insertScheduledTestSite(null);
    test("refuses to replace a live primary key with no encrypted parent copy", async () => {
      const child = await site();
      stubs.push(
        stub(bunnyHostingProvider, "getSecretNames", () =>
          Promise.resolve({ names: ["SCHEDULED_TASK_KEY"], ok: true }),
        ),
      );

      const result = await provisionSiteScheduler(child.id);

      expect(result).toEqual({
        error:
          "The child already has a scheduled task key that this site cannot read.",
        ok: false,
      });
      expect((await readBuiltSiteScheduler(child.id)).active).toBeNull();
    });

    test("fails loudly when the child record does not exist", async () => {
      await expect(provisionSiteScheduler(999_999)).rejects.toThrow(
        "Built site not found",
      );
    });

    test("fails loudly when the child disappears while provisioning", async () => {
      const child = await site();
      stubs.push(
        stub(builtSitesCrudTable, "findById", () => Promise.resolve(null)),
      );

      await expect(provisionSiteScheduler(child.id)).rejects.toThrow(
        `Built site not found: ${child.id}`,
      );
    });

    test("requires setup before staging a next key", async () => {
      const child = await site();
      expect(await stageSiteSchedulerRotation(child.id)).toEqual({
        error: "Set up scheduled maintenance before changing its key.",
        ok: false,
      });
    });

    test("requires provider access before provisioning", async () => {
      const child = await insertScheduledTestSite(null);
      await builtSitesCrudTable.update(child.id, { hostingId: "" });

      expect(await provisionSiteScheduler(child.id)).toEqual({
        error:
          "This site has no hosting ID, so its scheduled task key cannot be set.",
        ok: false,
      });
    });

    test("requires provider access before staging a next key", async () => {
      const child = await insertScheduledTestSite();
      await builtSitesCrudTable.update(child.id, { hostingId: "" });

      expect(await stageSiteSchedulerRotation(child.id)).toEqual({
        error:
          "This site has no hosting ID, so its scheduled task key cannot be changed.",
        ok: false,
      });
    });

    test("surfaces a provider secret-list failure", async () => {
      const child = await site();
      stubs.push(
        stub(bunnyHostingProvider, "getSecretNames", () =>
          Promise.resolve({ error: "cannot list", ok: false }),
        ),
      );

      expect(await provisionSiteScheduler(child.id)).toEqual({
        error: "cannot list",
        ok: false,
      });
    });

    test("refuses an unknown live next key", async () => {
      const child = await insertScheduledTestSite();
      stubs.push(
        stub(bunnyHostingProvider, "getSecretNames", () =>
          Promise.resolve({
            names: ["SCHEDULED_TASK_KEY_NEXT"],
            ok: true,
          }),
        ),
      );

      expect(await stageSiteSchedulerRotation(child.id)).toEqual({
        error:
          "The child already has a next scheduled task key that this site cannot read.",
        ok: false,
      });
    });

    test("retains one active key when provider setup fails", async () => {
      const child = await site();
      stubBunnySchedulerSecrets(stubs, [], { error: "host down", ok: false });

      expect((await provisionSiteScheduler(child.id)).ok).toBe(false);
      const first = (await readBuiltSiteScheduler(child.id)).active;
      expect((await provisionSiteScheduler(child.id)).ok).toBe(false);
      expect((await readBuiltSiteScheduler(child.id)).active).toBe(first);
    });

    test("requires an empty 204 from the live child", async () => {
      const child = await site();
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using fetchStub = stubFetch(new Response("unexpected", { status: 200 }));

      const result = await provisionSiteScheduler(child.id);

      expect(result).toEqual({
        error: "The child did not accept the scheduled task key.",
        ok: false,
      });
      const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://child.example.test/scheduled");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toMatch(
        /^Bearer [A-Za-z0-9_-]{43}$/,
      );
    });

    test("reports a failed live verification request", async () => {
      const child = await site();
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using _fetch = stubFetch(new Error("network down"));

      expect(await provisionSiteScheduler(child.id)).toEqual({
        error: "The child could not verify the scheduled task key.",
        ok: false,
      });
    });

    test("verifies only the child origin when its URL includes a path", async () => {
      const child = await insertBuiltSite(
        "Child",
        "HTTPS://child.example.test/unsafe/path",
        "",
        "",
        false,
        "42",
      );
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using fetchStub = stubFetch(new Response(null, { status: 204 }));

      expect((await provisionSiteScheduler(child.id)).ok).toBe(true);
      expect(String(fetchStub.calls[0]!.args[0])).toBe(
        "https://child.example.test/scheduled",
      );
    });

    test("retries a failed rotation with the same pending key", async () => {
      const child = await insertScheduledTestSite();
      const pushed: string[] = [];
      stubBunnySchedulerSecrets(stubs, ["SCHEDULED_TASK_KEY"], { ok: true });
      stubs.at(-1)!.restore();
      stubs.pop();
      stubs.push(
        stub(bunnyHostingProvider, "setSecrets", (_id, secrets) => {
          pushed.push(secrets[0]![1]);
          return Promise.resolve({ ok: true });
        }),
      );
      using fetchStub = stubFetch(
        new Response(null, { status: 503 }),
        new Response(null, { status: 204 }),
      );

      expect((await stageSiteSchedulerRotation(child.id)).ok).toBe(false);
      expect((await stageSiteSchedulerRotation(child.id)).ok).toBe(true);

      expect(pushed.length).toBe(2);
      expect(new Set(pushed).size).toBe(1);
      expect(fetchStub.calls.length).toBe(2);
    });

    test("promotes the verified pending key and clears the next slot", async () => {
      const child = await insertScheduledTestSite();
      stubBunnySchedulerSecrets(stubs, ["SCHEDULED_TASK_KEY"], { ok: true });
      stubs.push(
        stub(bunnyHostingProvider, "promoteSecrets", () =>
          Promise.resolve({ ok: true }),
        ),
      );
      using _fetch = stubFetch(new Response(null, { status: 204 }));
      await stageSiteSchedulerRotation(child.id);
      const pending = (await readBuiltSiteScheduler(child.id)).pending;

      const result = await promoteSiteSchedulerRotation(child.id);

      expect(result.ok).toBe(true);
      expect(await readBuiltSiteScheduler(child.id)).toMatchObject({
        active: pending,
        pending: null,
      });
    });

    test("requires a pending key before promotion", async () => {
      const child = await insertScheduledTestSite();

      expect(await promoteSiteSchedulerRotation(child.id)).toEqual({
        error: "This site has no scheduled task key ready to use.",
        ok: false,
      });
    });

    test("surfaces a provider promotion failure", async () => {
      const child = await insertScheduledTestSite();
      await ensureBuiltSiteSchedulerNextKey(child.id);
      stubs.push(
        stub(bunnyHostingProvider, "promoteSecrets", () =>
          Promise.resolve({ error: "promotion failed", ok: false }),
        ),
      );

      expect(await promoteSiteSchedulerRotation(child.id)).toEqual({
        error: "promotion failed",
        ok: false,
      });
    });

    test("requires provider access before promotion", async () => {
      const child = await insertScheduledTestSite();
      await ensureBuiltSiteSchedulerNextKey(child.id);
      await builtSitesCrudTable.update(child.id, { hostingId: "" });

      expect(await promoteSiteSchedulerRotation(child.id)).toEqual({
        error:
          "This site has no hosting ID, so its scheduled task key cannot be promoted.",
        ok: false,
      });
    });
  },
);
