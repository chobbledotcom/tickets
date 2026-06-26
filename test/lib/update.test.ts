import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import {
  deployLatestReleaseToDeno,
  deployRelease,
  formatBuildDate,
  isNewerVersion,
  setBuildTimestampForTest,
} from "#shared/update.ts";

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
      expect(result).toContain("2026");
      expect(result).toContain("UTC");
    });

    test("returns Development build for empty string", () => {
      expect(formatBuildDate("")).toBe("Development build");
    });
  });
});

const MOCK_RELEASE = {
  assets: [
    {
      browser_download_url:
        "https://github.com/example/releases/download/v2099-01-01-120000/bunny-script.ts",
      name: "bunny-script.ts",
    },
  ],
  name: "2099-01-01 - Big Update",
  published_at: "2099-01-01T12:00:00Z",
  tag_name: "v2099-01-01-120000",
};

const stubReleaseFetch = () =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_RELEASE), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response("console.log('code')", { status: 200 }),
    );
  });

describe("deployRelease", () => {
  test("downloads an asset URL and deploys to a Bunny script", async () => {
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("console.log('asset')", { status: 200 })),
    );
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ ok: true as const }),
    );
    try {
      await deployRelease("https://example.com/asset.ts", "9001");
      expect(deployStub.calls).toHaveLength(1);
    } finally {
      deployStub.restore();
      fetchStub.restore();
    }
  });

  test("throws when the deploy fails", async () => {
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("code", { status: 200 })),
    );
    const deployStub = stub(bunnyCdnApi, "deployScriptCode", () =>
      Promise.resolve({ error: "upload failed", ok: false as const }),
    );
    try {
      await expect(
        deployRelease("https://example.com/asset.ts"),
      ).rejects.toThrow("upload failed");
    } finally {
      deployStub.restore();
      fetchStub.restore();
    }
  });
});

describe("deployLatestReleaseToDeno", () => {
  test("fetches the latest release and deploys it to a Deno app", async () => {
    const fetchStub = stubReleaseFetch();
    const deployStub = stub(denoDeployApi, "deployCode", () =>
      Promise.resolve({ hostname: "https://app.deno.dev", ok: true as const }),
    );
    try {
      const release = await deployLatestReleaseToDeno("app_123");
      expect(release.tagName).toBe("v2099-01-01-120000");
      expect(deployStub.calls).toHaveLength(1);
      expect(deployStub.calls[0]!.args[0]).toBe("app_123");
    } finally {
      deployStub.restore();
      fetchStub.restore();
    }
  });
});
