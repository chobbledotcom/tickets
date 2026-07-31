import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { ensureBuiltSiteSchedulerKey } from "#shared/db/built-site-scheduler.ts";
import {
  builtSitesCrudTable,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import { provisionSiteScheduler } from "#shared/site-scheduler.ts";
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
          Promise.resolve({ ok: true, value: ["SCHEDULED_TASK_KEY"] }),
        ),
      );

      const result = await provisionSiteScheduler(child.id);

      expect(result).toEqual({
        error:
          "The child already has a scheduled task key that this site cannot read.",
        ok: false,
      });
      expect(
        (await builtSitesCrudTable.read.one({ id: child.id }))
          ?.scheduledTaskKey,
      ).toBeNull();
    });

    test("fails loudly when the child record does not exist", async () => {
      await expect(provisionSiteScheduler(999_999)).rejects.toThrow(
        "Built site not found",
      );
    });

    test("reuses the primary key when a replica read is stale", async () => {
      const child = await site();
      const stale = await builtSitesCrudTable.read.one({ id: child.id });
      const key = await ensureBuiltSiteSchedulerKey(child.id);
      const pushed: string[] = [];
      stubs.push(
        stub(builtSitesCrudTable.read, "one", () => Promise.resolve(stale)),
        stub(bunnyHostingProvider, "getSecretNames", () =>
          Promise.resolve({ ok: true, value: ["SCHEDULED_TASK_KEY"] }),
        ),
        stub(bunnyHostingProvider, "setSecrets", (_hostingId, secrets) => {
          pushed.push(secrets[0]![1]);
          return Promise.resolve({ ok: true, value: undefined });
        }),
      );
      using _fetch = stubFetch(new Response(null, { status: 204 }));

      expect(await provisionSiteScheduler(child.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(pushed).toEqual([key]);
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

    test("retains one active key when provider setup fails", async () => {
      const child = await site();
      stubBunnySchedulerSecrets(stubs, [], { error: "host down", ok: false });

      expect((await provisionSiteScheduler(child.id)).ok).toBe(false);
      const first = (await builtSitesCrudTable.read.one({ id: child.id }))
        ?.scheduledTaskKey;
      expect((await provisionSiteScheduler(child.id)).ok).toBe(false);
      expect(
        (await builtSitesCrudTable.read.one({ id: child.id }))
          ?.scheduledTaskKey,
      ).toBe(first);
    });

    test("requires an empty 204 from the live child", async () => {
      const child = await site();
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using fetchStub = stubFetch(new Response(null, { status: 200 }));

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
  },
);
