import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi, type PreparedBuildSite } from "#shared/builder.ts";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";

const input = {
  code: "addEventListener('fetch', () => {})",
  dbToken: "token",
  dbUrl: "libsql://child.example.test",
  siteName: "Child",
} as const;

describeWithEnv("builder scheduled keys", { encryptionKey: true }, () => {
  const stubs: { restore(): void }[] = [];
  restoreStubsAfterEach(stubs);

  const stubHosting = (calls: string[]): void => {
    stubs.push(
      stub(bunnyHostingProvider, "prepareSite", (_name, _code, secrets) => {
        calls.push(`prepare:${secrets.map(([name]) => name).join(",")}`);
        return Promise.resolve({
          defaultHostname: "child.b-cdn.net",
          hostingId: "42",
          ok: true,
        });
      }),
      stub(bunnyHostingProvider, "publishSite", () => {
        calls.push("publish");
        return Promise.resolve({ ok: true });
      }),
    );
  };

  test("creates a distinct 256-bit key for every child", async () => {
    const calls: string[] = [];
    const retained: PreparedBuildSite[] = [];
    stubHosting(calls);

    await builderApi.buildSite(input, (site) => {
      retained.push(site);
      return Promise.resolve();
    });
    await builderApi.buildSite({ ...input, siteName: "Other" }, (site) => {
      retained.push(site);
      return Promise.resolve();
    });

    expect(retained.length).toBe(2);
    expect(retained[0]!.scheduledTaskKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(retained[1]!.scheduledTaskKey).not.toBe(
      retained[0]!.scheduledTaskKey,
    );
  });

  test("retains the generated key before publishing", async () => {
    const calls: string[] = [];
    stubHosting(calls);

    const result = await builderApi.buildSite(input, (site) => {
      calls.push(`retain:${site.scheduledTaskKey.length}`);
      return Promise.resolve();
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "prepare:DB_URL,DB_TOKEN,DB_ENCRYPTION_KEY,SCHEDULED_TASK_KEY",
      "retain:43",
      "publish",
    ]);
  });

  test("does not publish when durable retention fails", async () => {
    const calls: string[] = [];
    stubHosting(calls);

    const result = await builderApi.buildSite(input, () =>
      Promise.reject(new Error("database write failed")),
    );

    expect(result).toEqual({
      error: "Failed to retain site: database write failed",
      ok: false,
    });
    expect(calls.some((call) => call === "publish")).toBe(false);
  });

  test("keeps the durable record when publishing fails", async () => {
    const calls: string[] = [];
    const retained: PreparedBuildSite[] = [];
    stubHosting(calls);
    stubs.at(-1)!.restore();
    stubs.pop();
    stubs.push(
      stub(bunnyHostingProvider, "publishSite", () =>
        Promise.resolve({ error: "publish failed", ok: false }),
      ),
    );

    const result = await builderApi.buildSite(input, (site) => {
      retained.push(site);
      return Promise.resolve();
    });

    expect(result.ok).toBe(false);
    expect(retained.length).toBe(1);
    expect(retained[0]!.scheduledTaskKey.length).toBe(43);
  });
});
