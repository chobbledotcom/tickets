import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PREVIEW_USAGE,
  type PreviewIo,
  runPreview,
} from "#scripts/preview/run.ts";
import { fakeBunny } from "./fake-bunny.ts";
import { fakeSite } from "./fake-site.ts";
import { fakeStripe } from "./fake-stripe.ts";

/* jscpd:ignore-start -- static data, not code */
const ENV: Record<string, string> = {
  BUNNY_ACCESS_KEY: "staging-key",
  HOST_EMAIL_API_KEY: "mail-key",
  HOST_EMAIL_FROM_ADDRESS: "tickets@example.com",
  HOST_EMAIL_PROVIDER: "resend",
  PREVIEW_OWNER_PASSWORD: "owner-password",
  PREVIEW_OWNER_USERNAME: "owner",
  SQUARE_ACCESS_TOKEN: "EAAAsandbox",
  SQUARE_LOCATION_ID: "LOC1",
  STAGING_STORAGE_ZONE_KEY: "zone-key",
  STAGING_STORAGE_ZONE_NAME: "staging-zone",
  STRIPE_SECRET_KEY: "sk_test_x",
  SUMUP_API_KEY: "sumup-key",
  SUMUP_MERCHANT_CODE: "MCODE",
};
/* jscpd:ignore-end */

/** The fake accounts and sites that one run talks to. */
type Services = {
  bunny?: ReturnType<typeof fakeBunny>;
  site?: ReturnType<typeof fakeSite>;
  stripe?: ReturnType<typeof fakeStripe>;
};

const harness = (
  args: string[],
  env: Record<string, string | undefined> = ENV,
  {
    bunny = fakeBunny(),
    site = fakeSite(),
    stripe = fakeStripe(),
  }: Services = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const reads: string[] = [];
  const sent: string[] = [];
  const io: PreviewIo = {
    args,
    fetchText: (url, init) =>
      (url.startsWith("https://api.stripe.com") ? stripe : bunny).fetchText(
        url,
        init,
      ),
    getEnv: (key) => env[key],
    newEncryptionKey: () => "encryption-key",
    newScheduledTaskKey: () => "task-key",
    readTextFile: (path) => {
      reads.push(path);
      return Promise.resolve("bundle code");
    },
    send: (request) => {
      sent.push(request.url);
      return site.send(request);
    },
    sleep: () => Promise.resolve(),
    stderr: (line) => err.push(line),
    stdout: (line) => out.push(line),
  };
  return { bunny, err, io, out, reads, sent, stripe };
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
      ["configure with no address", ["configure"]],
      ["configure with an extra argument", ["configure", "https://s.x", "y"]],
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
        "site_url=https://site-1.b-cdn.net",
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
      const first = harness(["ensure", "fix/a", "bundle.ts"], ENV, { bunny });
      await runPreview(first.io);
      const second = harness(["ensure", "fix/a", "bundle.ts"], ENV, { bunny });

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
      await runPreview(harness(["ensure", "fix/a", "b.ts"], ENV, { bunny }).io);
      const { err, io, out } = harness(["remove", "fix/a"], ENV, { bunny });

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

    test("deletes the Stripe webhooks of the site, and no others", async () => {
      const bunny = fakeBunny();
      await runPreview(harness(["ensure", "fix/a", "b.ts"], ENV, { bunny }).io);
      const stripe = fakeStripe([
        "https://site-1.b-cdn.net/payment/webhook",
        "https://other.b-cdn.net/payment/webhook",
      ]);
      const { err, io } = harness(["remove", "fix/a"], ENV, { bunny, stripe });

      expect(await runPreview(io)).toBe(0);
      expect(err[0]).toMatch(
        /: Stripe webhook we_1, script 1, pull zone 1001, database db-2\.$/,
      );
      expect([...stripe.endpoints.values()]).toEqual([
        "https://other.b-cdn.net/payment/webhook",
      ]);
      expect(
        stripe.calls.every((call) => call.auth === "Bearer sk_test_x"),
      ).toBe(true);
    });

    test("needs the Stripe key, before it deletes anything", async () => {
      const bunny = fakeBunny();
      await runPreview(harness(["ensure", "fix/a", "b.ts"], ENV, { bunny }).io);
      const { err, io } = harness(
        ["remove", "fix/a"],
        { ...ENV, STRIPE_SECRET_KEY: undefined },
        { bunny },
      );

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual([
        "Set these secrets for the preview: STRIPE_SECRET_KEY.",
      ]);
      expect(bunny.scripts.size).toBe(1);
    });
  });

  describe("configure", () => {
    test("sets up the site at its stable address, and needs no Bunny key", async () => {
      const { err, io, out, sent } = harness(
        ["configure", "https://site-1.bunny.run"],
        { ...ENV, BUNNY_ACCESS_KEY: undefined },
      );

      expect(await runPreview(io)).toBe(0);
      expect(out).toEqual([]);
      expect(err).toEqual([
        "Setup completed.\nsumup configured.\nsquare configured.\nstripe configured.",
      ]);
      expect(sent[0]).toBe("https://site-1.b-cdn.net/setup/");
    });

    test("names the secrets that the setup misses", async () => {
      const { err, io, sent } = harness(
        ["configure", "https://site-1.bunny.run"],
        {
          ...ENV,
          PREVIEW_OWNER_PASSWORD: undefined,
        },
      );

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual([
        "Set these secrets for the preview: PREVIEW_OWNER_PASSWORD.",
      ]);
      expect(sent).toEqual([]);
    });

    test("fails with the reason when the site never answers", async () => {
      const { err, io } = harness(
        ["configure", "https://site-1.bunny.run"],
        ENV,
        { site: fakeSite({ setupAnswers: [503] }) },
      );

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual([
        "The site gave no answer after 18 tries (status 503).",
      ]);
    });
  });

  for (const args of [
    ["ensure", "b", "bundle.ts"],
    ["remove", "b"],
  ]) {
    test(`${args[0]} fails with the Bunny error`, async () => {
      const { err, io } = harness(args, ENV, {
        bunny: fakeBunny({ fails: { "GET /compute/script": 401 } }),
      });

      expect(await runPreview(io)).toBe(1);
      expect(err).toEqual(["List scripts failed (401): boom"]);
    });
  }
});
