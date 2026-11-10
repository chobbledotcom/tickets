/**
 * Tests for the inter-instance machine endpoint (POST /instance/site-credentials).
 *
 * The main/builder instance returns every built site's read-only DB credentials
 * to a caller holding MAIN_INSTANCE_KEY, so the upgrade workflow can back each
 * site up before deploying. Disabled (404) unless the key is set; 401 on a bad
 * key; only sites with a script id and credentials are returned.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import type { UpdateTier } from "#db/built-sites/types.ts";
import { insertBuiltSite } from "#db/built-sites.ts";
import { handleRequest } from "#routes";
import { ErrorCode } from "#shared/logger.ts";
import { initSentry } from "#shared/sentry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { resetSentry } from "#test-utils/sentry.ts";

const KEY = "instance-key-0123456789abcdef0123456789abcdef";

/** POST /instance/site-credentials with optional headers and `?tier=`. */
const post = (
  headers?: Record<string, string>,
  tier?: string,
): Promise<Response> =>
  handleRequest(
    mockRequest(
      tier === undefined
        ? "/instance/site-credentials"
        : `/instance/site-credentials?tier=${tier}`,
      { ...(headers !== undefined ? { headers } : {}), method: "POST" },
    ),
  );

/** Sorted site names from a 200 credentials response. */
const siteNames = async (response: Response): Promise<string[]> => {
  const body = (await response.json()) as { sites: { name: string }[] };
  return body.sites.map((site) => site.name).sort();
};

/** One eligible site (script id + read-only creds) per update channel. */
const TIERED_SITES: readonly [name: string, tier: UpdateTier][] = [
  ["AlphaSite", "alpha"],
  ["BetaSite", "beta"],
  ["ReleaseSite", "release"],
];

const seedTieredFleet = async (): Promise<void> => {
  for (const [name, tier] of TIERED_SITES) {
    await insertBuiltSite(
      name,
      `${tier}.b-cdn.net`,
      `libsql://${tier}`,
      `tok-${tier}`,
      false,
      `script-${tier}`,
      tier,
    );
  }
};

/** Run `fn` with the credentials endpoint enabled and a one-per-channel fleet seeded. */
const withTieredFleet = async (fn: () => Promise<void>): Promise<void> => {
  using _env = withEnv({ MAIN_INSTANCE_KEY: KEY });
  await seedTieredFleet();
  await fn();
};

const auth = { authorization: `Bearer ${KEY}` };

describeWithEnv("server (instance site-credentials)", { db: true }, () => {
  test("returns 404 when MAIN_INSTANCE_KEY is not configured", async () => {
    const response = await post({ authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("returns 401 when the bearer key is missing", async () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: KEY });
    const response = await post();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("returns 401 when the bearer key is wrong", async () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: KEY });
    const response = await post({ authorization: "Bearer not-the-key" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("rejects a key without the exact bearer scheme", async () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: KEY });
    for (const authorization of [KEY, `bearer ${KEY}`, `Token ${KEY}`]) {
      const response = await post({ authorization });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("returns read-only credentials for sites that have them", async () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: KEY });
    await insertBuiltSite(
      "Acme",
      "acme.b-cdn.net",
      "libsql://acme.lite.bunnydb.net",
      "ro-token-acme",
      false,
      "script-acme",
    );
    // A half-provisioned site (no script id / credentials) is omitted.
    await insertBuiltSite("Pending", "pending.b-cdn.net");
    await insertBuiltSite(
      "Deno",
      "deno.example",
      "libsql://deno",
      "deno-token",
      false,
      "deno-app",
      "release",
      "deno",
      "bunny",
    );
    await insertBuiltSite("No URL", "no-url.example", "", "token", false, "1");
    await insertBuiltSite(
      "No token",
      "no-token.example",
      "libsql://no-token",
      "",
      false,
      "2",
    );

    const response = await post({ authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sites: [
        {
          dbToken: "ro-token-acme",
          dbUrl: "libsql://acme.lite.bunnydb.net",
          name: "Acme",
          scriptId: "script-acme",
          siteUrl: "acme.b-cdn.net",
        },
      ],
      tier: "release",
    });
  });

  describe("tier filtering", () => {
    test("an alpha deploy returns only alpha sites", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "alpha");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual(["AlphaSite"]);
      }));

    test("a beta deploy returns beta and alpha sites", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "beta");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual(["AlphaSite", "BetaSite"]);
      }));

    test("a release deploy returns the whole fleet", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "release");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("omitting the tier defaults to release (the whole fleet)", () =>
      withTieredFleet(async () => {
        const response = await post(auth);
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("an empty tier param defaults to release", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("an unrecognised tier is rejected with 400", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "stable");
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_tier" });
      }));

    test("echoes the applied tier so the caller can confirm filtering", () =>
      withTieredFleet(async () => {
        const beta = (await (await post(auth, "beta")).json()) as {
          tier: string;
        };
        expect(beta.tier).toBe("beta");
        // A tier-less call resolves to the release default and says so.
        const fallback = (await (await post(auth)).json()) as { tier: string };
        expect(fallback.tier).toBe("release");
      }));
  });

  describe("call reporting", () => {
    const errorSpy = setupErrorSpy();

    const NTFY_URL = "https://ntfy.example.test/site-credentials";
    const SENTRY_HOST = "bugs.example.test";
    /** A bearer token that never matches, so a report must never repeat it. */
    const GUESSED_KEY = "guessed-key-0123456789abcdef0123456789abcdef";
    /** A tier no build accepts, so the caller's own text is never echoed. */
    const UNKNOWN_TIER = "stable-marker";

    /** Run `fn` with the endpoint and both report channels live. */
    const withReports = async <T>(
      env: Record<string, string | undefined>,
      fn: (fetchStub: Stub) => Promise<T>,
    ): Promise<T> => {
      using _env = withEnv({
        NTFY_URL,
        SENTRY_URL: `https://key@${SENTRY_HOST}/2`,
        ...env,
      });
      using fetchStub = stubFetch(() => new Response("{}"));
      await initSentry();
      try {
        return await fn(fetchStub);
      } finally {
        resetSentry();
      }
    };

    /** One call to the endpoint, the unchanged answer, and its one report. */
    type CallCase = {
      /** The test name, which says what the call does. */
      name: string;
      /** The key the site is configured with. Absent ⇒ the endpoint is off. */
      key: string | undefined;
      /** The Authorization header the caller presents. */
      authorization: string;
      /** The tier the caller names, if any. */
      tier?: string | undefined;
      /** Seed the one-per-channel fleet before the call. */
      fleet?: boolean | undefined;
      /** The answer's status, and either its error code or text it carries. */
      answer:
        | { status: number; error: string }
        | { status: number; carries: readonly string[] };
      /** The report the operator receives. Null ⇒ the call reports nothing. */
      report: { code: string; detail: string } | null;
      /** Values that no report may repeat. */
      secrets: readonly string[];
    };

    const CALL_CASES: readonly CallCase[] = [
      {
        answer: { error: "unauthorized", status: 401 },
        authorization: `Bearer ${GUESSED_KEY}`,
        key: KEY,
        name: "reports a refused call under its own code",
        report: {
          code: ErrorCode.INSTANCE_CREDENTIALS_REFUSED,
          detail: "bearer token missing or wrong",
        },
        secrets: [KEY, GUESSED_KEY, "MAIN_INSTANCE_KEY"],
      },
      {
        answer: { carries: ["libsql://beta", "tok-beta"], status: 200 },
        authorization: `Bearer ${KEY}`,
        fleet: true,
        key: KEY,
        name: "reports an accepted call with its tier and site count",
        report: {
          code: ErrorCode.INSTANCE_CREDENTIALS_ACCEPTED,
          detail: "tier=beta sites=2",
        },
        secrets: [
          KEY,
          "MAIN_INSTANCE_KEY",
          "libsql://alpha",
          "tok-alpha",
          "libsql://beta",
          "tok-beta",
        ],
        tier: "beta",
      },
      {
        answer: { error: "invalid_tier", status: 400 },
        authorization: `Bearer ${KEY}`,
        key: KEY,
        name: "reports an accepted call that named an unknown tier, without echoing it",
        report: {
          code: ErrorCode.INSTANCE_CREDENTIALS_ACCEPTED,
          detail: "unknown tier requested, no sites returned",
        },
        secrets: [KEY, UNKNOWN_TIER],
        tier: UNKNOWN_TIER,
      },
      {
        answer: { error: "not_found", status: 404 },
        authorization: `Bearer ${KEY}`,
        key: undefined,
        name: "reports nothing while the endpoint is disabled",
        report: null,
        secrets: [KEY],
      },
    ];

    /** What one call produced, as the test compares it. */
    type CallOutcome = {
      status: number;
      /** The answer body as text. */
      body: string;
      /** The console report lines, without the request-id prefix. */
      lines: string[];
      /** The ntfy message bodies, in order. */
      ntfy: string[];
      /** How many Sentry events went out. */
      sentryEvents: number;
      /** Everything those reports carried, as one searchable string. */
      reportText: string;
    };

    /** A fetch call's request body, whether the stub passed text or bytes. */
    const requestBody = (init: RequestInit | undefined): string => {
      const body = init?.body;
      return typeof body === "string"
        ? body
        : new TextDecoder().decode(body as Uint8Array);
    };

    /** Make one call under live reporting and record what came back and out. */
    const observeCall = (callCase: CallCase): Promise<CallOutcome> =>
      withReports({ MAIN_INSTANCE_KEY: callCase.key }, async (fetchStub) => {
        if (callCase.fleet) await seedTieredFleet();
        const response = await post(
          { authorization: callCase.authorization },
          callCase.tier,
        );
        const body = await response.text();

        const ntfyCalls = fetchStub.calls.filter(
          (call) => String(call.args[0]) === NTFY_URL,
        );
        const sentryCalls = fetchStub.calls.filter((call) =>
          String(call.args[0]).includes(SENTRY_HOST),
        );
        const lines = errorSpy.calls
          .map((call) => String(call.args[0]))
          .filter((line) => line.includes("E_INSTANCE_CREDENTIALS_"))
          .map((line) => line.replace(/^\[[0-9a-f]{4}\] /, ""));
        const ntfy = ntfyCalls.map((call) =>
          requestBody(call.args[1] as RequestInit | undefined),
        );
        const sentry = sentryCalls.map((call) =>
          requestBody(call.args[1] as RequestInit | undefined),
        );

        return {
          body,
          lines,
          ntfy,
          reportText: [
            ...lines,
            ...ntfyCalls.map((call) => JSON.stringify(call.args)),
            ...sentry,
          ].join("\n"),
          sentryEvents: sentryCalls.length,
          status: response.status,
        };
      });

    /** Assert the report reached every sink, or that none went out. */
    const expectReport = (
      outcome: CallOutcome,
      report: CallCase["report"],
    ): void => {
      const expectedLines =
        report === null
          ? []
          : [`[Error] ${report.code} detail="${report.detail}"`];
      expect(outcome.lines).toEqual(expectedLines);
      expect(outcome.ntfy).toEqual(report === null ? [] : [report.code]);
      expect(outcome.sentryEvents).toBe(report === null ? 0 : 1);
    };

    /** Assert no report repeated a value the operator must never see. */
    const expectNoSecrets = (
      outcome: CallOutcome,
      secrets: readonly string[],
    ): void => {
      for (const secret of secrets) {
        expect(outcome.reportText).not.toContain(secret);
      }
    };

    for (const callCase of CALL_CASES) {
      test(callCase.name, async () => {
        const outcome = await observeCall(callCase);

        expect(outcome.status).toBe(callCase.answer.status);
        if ("error" in callCase.answer) {
          expect(JSON.parse(outcome.body)).toEqual({
            error: callCase.answer.error,
          });
        } else {
          // Control: the answer itself does carry the fleet's secrets.
          for (const fragment of callCase.answer.carries) {
            expect(outcome.body).toContain(fragment);
          }
        }

        expectReport(outcome, callCase.report);
        expectNoSecrets(outcome, callCase.secrets);
      });
    }
  });
});
