import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PREVIEW_USAGE,
  type PreviewIo,
  runPreview,
} from "#scripts/preview/run.ts";
import { fakeBunny } from "./fake-bunny.ts";

const ENV: Record<string, string> = {
  BUNNY_ACCESS_KEY: "staging-key",
  HOST_EMAIL_API_KEY: "mail-key",
  HOST_EMAIL_FROM_ADDRESS: "tickets@example.com",
  HOST_EMAIL_PROVIDER: "resend",
  STAGING_STORAGE_ZONE_KEY: "zone-key",
  STAGING_STORAGE_ZONE_NAME: "staging-zone",
};

const harness = (
  args: string[],
  env: Record<string, string | undefined> = ENV,
  bunny = fakeBunny(),
) => {
  const out: string[] = [];
  const err: string[] = [];
  const reads: string[] = [];
  const io: PreviewIo = {
    args,
    fetchText: bunny.fetchText,
    getEnv: (key) => env[key],
    newEncryptionKey: () => "encryption-key",
    newScheduledTaskKey: () => "task-key",
    readTextFile: (path) => {
      reads.push(path);
      return Promise.resolve("bundle code");
    },
    stderr: (line) => err.push(line),
    stdout: (line) => out.push(line),
  };
  return { bunny, err, io, out, reads };
};

describe("runPreview", () => {
  describe("usage", () => {
    const bad: [string, string[]][] = [
      ["no arguments", []],
      ["an unknown command", ["deploy", "branch"]],
      ["ensure with no bundle file", ["ensure", "branch"]],
      ["ensure with a blank bundle file", ["ensure", "branch", " "]],
      ["ensure with an extra argument", ["ensure", "branch", "b.ts", "x"]],
      ["a blank branch", ["remove", " "]],
      ["remove with a bundle file", ["remove", "branch", "b.ts"]],
    ];

    for (const [label, args] of bad) {
      test(`refuses ${label}`, async () => {
        const { err, io } = harness(args);

        expect(await runPreview(io)).toBe(1);
        expect(err).toEqual([PREVIEW_USAGE]);
      });
    }
  });

  test("needs the account key", async () => {
    const { err, io } = harness(["remove", "branch"], {});

    expect(await runPreview(io)).toBe(1);
    expect(err).toEqual([
      "BUNNY_ACCESS_KEY is required (BUNNY_API_KEY also works).",
    ]);
  });

  describe("ensure", () => {
    test("prints the output lines for the workflow and nothing else on stdout", async () => {
      const { bunny, io, out, reads } = harness([
        "ensure",
        "fix/a",
        "bundle.ts",
      ]);

      expect(await runPreview(io)).toBe(0);
      expect(out).toEqual([
        "script_id=1",
        "site_url=https://site-1.bunny.run",
        "published=true",
      ]);
      expect(reads).toEqual(["bundle.ts"]);
      expect(bunny.scripts.get(1)?.code).toBe("bundle code");
      expect(bunny.scripts.get(1)?.secrets.get("DB_ENCRYPTION_KEY")).toBe(
        "encryption-key",
      );
      expect(bunny.scripts.get(1)?.secrets.get("SCHEDULED_TASK_KEY")).toBe(
        "task-key",
      );
    });

    test("names the preview and says whether it published", async () => {
      const { err, io } = harness(["ensure", "fix/a", "bundle.ts"]);

      await runPreview(io);

      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(
        /^Preview "Tickets - preview-fix-a-[0-9a-f]{6}" is ready\. This run published the code\.$/,
      );
    });

    test("says when the caller must deploy the code", async () => {
      const bunny = fakeBunny();
      const first = harness(["ensure", "fix/a", "bundle.ts"], ENV, bunny);
      await runPreview(first.io);
      const second = harness(["ensure", "fix/a", "bundle.ts"], ENV, bunny);

      expect(await runPreview(second.io)).toBe(0);
      expect(second.out).toContain("published=false");
      expect(second.err[0]).toContain("did not publish the code");
    });

    test("never prints a secret value", async () => {
      const { err, io, out } = harness(["ensure", "fix/a", "bundle.ts"]);

      await runPreview(io);

      const printed = [...out, ...err].join("\n");
      for (const secret of [
        "staging-key",
        "mail-key",
        "zone-key",
        "encryption-key",
      ]) {
        expect(printed).not.toContain(secret);
      }
    });

    test("fails before any Bunny call when a copied secret is missing", async () => {
      const { bunny, err, io } = harness(["ensure", "b", "bundle.ts"], {
        ...ENV,
        HOST_EMAIL_API_KEY: undefined,
      });

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual([
        "Set these secrets for the preview: HOST_EMAIL_API_KEY.",
      ]);
      expect(bunny.calls).toEqual([]);
    });
  });

  describe("remove", () => {
    test("deletes the preview of the branch and says what it deleted", async () => {
      const bunny = fakeBunny();
      await runPreview(harness(["ensure", "fix/a", "b.ts"], ENV, bunny).io);
      const { err, io, out } = harness(["remove", "fix/a"], ENV, bunny);

      expect(await runPreview(io)).toBe(0);
      expect(out).toEqual([]);
      expect(err[0]).toMatch(
        /^Deleted preview "Tickets - preview-fix-a-[0-9a-f]{6}": script 1, pull zone 1001, database db-2\.$/,
      );
      expect(bunny.scripts.size).toBe(0);
    });

    test("succeeds when there is nothing to delete", async () => {
      const { err, io } = harness(["remove", "fix/a"]);

      expect(await runPreview(io)).toBe(0);
      expect(err[0]).toMatch(/does not exist\. Nothing to delete\.$/);
    });
  });

  for (const args of [
    ["ensure", "b", "bundle.ts"],
    ["remove", "b"],
  ]) {
    test(`${args[0]} fails with the Bunny error`, async () => {
      const { err, io } = harness(
        args,
        ENV,
        fakeBunny({ fails: { "GET /compute/script": 401 } }),
      );

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual(["List scripts failed (401): boom"]);
    });
  }
});
