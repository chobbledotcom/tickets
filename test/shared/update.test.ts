import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  CURRENT_SCRIPT_VERSION_KEY,
  deployLatestReleaseToDeno,
  deployRelease,
  fetchLatestRelease,
  formatBuildDate,
  GITHUB_RELEASES_URL,
  GITHUB_REPO,
  isNewerVersion,
  readRecordedScriptCommit,
  recordScriptVersion,
  setBuildCommitForTest,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { MOCK_RELEASE, stubReleaseFetch } from "#test-utils/mocks.ts";

describe("update constants", () => {
  test("points to the public tickets release page", () => {
    expect(GITHUB_REPO).toBe("chobbledotcom/tickets");
    expect(GITHUB_RELEASES_URL).toBe(
      "https://github.com/chobbledotcom/tickets/releases",
    );
    expect(CURRENT_SCRIPT_VERSION_KEY).toBe("current_script_version");
  });
});

describe("update", () => {
  afterEach(() => {
    setBuildTimestampForTest(null);
  });

  describe("isNewerVersion", () => {
    test("returns false in development (no build timestamp)", () => {
      expect(isNewerVersion("v2099-01-01-000000")).toBe(false);
    });

    test("returns false for unparseable tags", () => {
      setBuildTimestampForTest("2026-01-01T00:00:00Z");
      expect(isNewerVersion("invalid")).toBe(false);
      expect(isNewerVersion("1.0.0")).toBe(false);
      expect(isNewerVersion("v2026-03-28")).toBe(false);
    });

    test("returns true when release tag is newer than build", () => {
      setBuildTimestampForTest("2026-01-01T00:00:00Z");
      expect(isNewerVersion("v2026-06-15-120000")).toBe(true);
    });

    test("returns false when release tag is older than build", () => {
      setBuildTimestampForTest("2026-06-15T12:00:00Z");
      expect(isNewerVersion("v2026-01-01-000000")).toBe(false);
    });

    test("returns false when release tag equals build timestamp", () => {
      setBuildTimestampForTest("2026-03-28T14:30:22Z");
      expect(isNewerVersion("v2026-03-28-143022")).toBe(false);
    });

    test("handles build date newer than latest release", () => {
      // Simulates a deploy-to-clients build that's newer than the latest release
      setBuildTimestampForTest("2026-04-01T10:00:00Z");
      expect(isNewerVersion("v2026-03-28-143022")).toBe(false);
    });
  });

  describe("formatBuildDate", () => {
    test("formats an ISO timestamp for display", () => {
      const result = formatBuildDate("2026-03-28T14:30:22.000Z");
      expect(result).toBe("Sat, 28 Mar 2026 14:30:22 UTC");
    });

    test("returns Development build for empty string", () => {
      expect(formatBuildDate("")).toBe("Development build");
    });
  });
});

describe("fetchLatestRelease", () => {
  test("sends the GitHub release media type", async () => {
    using fetchStub = stubReleaseFetch();

    await fetchLatestRelease();

    const init = fetchStub.calls[0]!.args[1];
    expect(new Headers(init?.headers).get("Accept")).toBe(
      "application/vnd.github.v3+json",
    );
  });

  test("returns every release field", async () => {
    using _fetch = stubReleaseFetch();

    expect(await fetchLatestRelease()).toEqual({
      assetUrl:
        "https://github.com/chobbledotcom/tickets/releases/download/v2099-01-01-120000/bunny-script.ts",
      name: "2099-01-01 - Big Update",
      publishedAt: "2099-01-01T12:00:00Z",
      tagName: "v2099-01-01-120000",
    });
  });

  test("preserves an empty matching asset URL", async () => {
    using _fetch = stubFetch(
      new Response(
        JSON.stringify({
          ...MOCK_RELEASE,
          assets: [{ browser_download_url: "", name: "bunny-script.ts" }],
        }),
      ),
    );

    expect((await fetchLatestRelease()).assetUrl).toBe("");
  });

  test("throws the GitHub status when the release lookup fails", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify(MOCK_RELEASE), { status: 503 }),
    );

    await expect(fetchLatestRelease()).rejects.toThrow(
      "GitHub API returned 503",
    );
  });

  test("names a blocked GitHub release lookup", async () => {
    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          { database: 50, external: 0, total: 0 },
          fetchLatestRelease,
        ),
      ),
    ).rejects.toThrow("Blocked external operation: GitHub release lookup");
  });
});

describe("deployRelease", () => {
  test("downloads an asset URL and deploys to a Bunny script", async () => {
    using _fetch = stubFetch(new Response("console.log('asset')"));
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ ok: true as const }),
    );
    try {
      await deployRelease("https://example.com/asset.ts", "9001");
      expect(deployStub.calls).toHaveLength(1);
    } finally {
      deployStub.restore();
    }
  });

  test("throws when the deploy fails", async () => {
    using _fetch = stubFetch(new Response("code"));
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ error: "upload failed", ok: false as const }),
    );
    try {
      await expect(
        deployRelease("https://example.com/asset.ts"),
      ).rejects.toThrow("upload failed");
    } finally {
      deployStub.restore();
    }
  });

  test("throws the asset status when the download fails", async () => {
    using _fetch = stubFetch(new Response("Unavailable", { status: 503 }));
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ ok: true as const }),
    );
    try {
      await expect(
        deployRelease("https://example.com/asset.ts"),
      ).rejects.toThrow("Failed to download release asset: 503");
    } finally {
      deployStub.restore();
    }
  });

  test("names a blocked GitHub release download", async () => {
    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 50, external: 0, total: 0 }, () =>
          deployRelease("https://example.com/asset.ts"),
        ),
      ),
    ).rejects.toThrow("Blocked external operation: GitHub release download");
  });
});

describe("deployLatestReleaseToDeno", () => {
  test("fetches the latest release and deploys it to a Deno app", async () => {
    using _fetch = stubReleaseFetch();
    const deployStub = stub(denoDeployApi, "deployCode", () =>
      Promise.resolve({
        hostname: "https://app.deno.dev",
        ok: true as const,
      }),
    );
    try {
      await runWithSubrequestBudget(async () => {
        const release = await deployLatestReleaseToDeno("app_123");
        expect(release.tagName).toBe("v2099-01-01-120000");
        expect(getSubrequestUsage()).toEqual({
          database: 0,
          external: 2,
          total: 2,
        });
      });
      expect(deployStub.calls).toHaveLength(1);
      expect(deployStub.calls[0]!.args[0]).toBe("app_123");
    } finally {
      deployStub.restore();
    }
  });

  test("names a release with no downloadable asset", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ ...MOCK_RELEASE, assets: [] })),
    );

    await expect(deployLatestReleaseToDeno("app_123")).rejects.toThrow(
      "Release has no downloadable asset",
    );
  });
});

describeWithEnv("recordScriptVersion", { db: true }, () => {
  const commitKey = "current_script_commit";
  const markerKeys = [commitKey, CURRENT_SCRIPT_VERSION_KEY];
  const clearMarkers = (): Promise<unknown> =>
    execute("DELETE FROM settings WHERE key IN (?, ?)", markerKeys);
  const markerRows = (): Promise<{ key: string; value: string }[]> =>
    queryAll<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key IN (?, ?) ORDER BY key",
      markerKeys,
    );

  afterEach(() => {
    setBuildTimestampForTest(null);
    setBuildCommitForTest(null);
  });

  test("stores the commit under its stable plaintext key", async () => {
    setBuildCommitForTest("abc123def4567890");
    await recordScriptVersion();

    expect(
      await queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'current_script_commit'",
      ),
    ).toEqual({ value: "abc123def4567890" });
  });

  test("does not create an empty commit marker for a version-only build", async () => {
    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    setBuildCommitForTest("");
    await recordScriptVersion();

    expect(
      await queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'current_script_commit'",
      ),
    ).toBeNull();
  });

  test("stores the exact rows for each available build marker", async () => {
    await clearMarkers();
    setBuildTimestampForTest("");
    setBuildCommitForTest("");
    await runWithSubrequestBudget(async () => {
      await recordScriptVersion();
      expect(getSubrequestUsage()).toEqual({
        database: 0,
        external: 0,
        total: 0,
      });
    });
    expect(await readRecordedScriptCommit()).toBe("");

    setBuildTimestampForTest("2026-06-19T12:00:00Z");
    await recordScriptVersion();
    expect(await markerRows()).toEqual([
      {
        key: CURRENT_SCRIPT_VERSION_KEY,
        value: "2026-06-19T12:00:00Z",
      },
    ]);

    await clearMarkers();
    setBuildTimestampForTest("");
    setBuildCommitForTest("abc123def4567890");
    await recordScriptVersion();
    expect(await markerRows()).toEqual([
      { key: commitKey, value: "abc123def4567890" },
    ]);

    await clearMarkers();
    await execute("INSERT INTO settings (key, value) VALUES (?, ?)", [
      commitKey,
      "stale-commit",
    ]);
    setBuildTimestampForTest("2026-06-20T00:00:00Z");
    setBuildCommitForTest("");
    await recordScriptVersion();
    expect(await markerRows()).toEqual([
      { key: commitKey, value: "" },
      {
        key: CURRENT_SCRIPT_VERSION_KEY,
        value: "2026-06-20T00:00:00Z",
      },
    ]);
  });
});
