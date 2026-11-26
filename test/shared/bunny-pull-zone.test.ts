import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMockBunnyCdnApi, withMocks } from "#test-utils/mocks.ts";
import { expectErrorResult } from "./bunny/fixtures.ts";

/** Build an edge script API response */
const edgeScriptResponse = (
  pullZones: { Id: number }[] = [],
  defaultHostname = "mysite.b-cdn.net",
) => ({
  DefaultHostname: defaultHostname,
  LinkedPullZones: pullZones,
});

/** The single linked pull zone most edge-script tests exercise. */
const SINGLE_PULL_ZONE = [{ Id: 222 }];

/** Call a derived lookup while bunnyCdnApi.getEdgeScript is replaced, and
 *  expect the replacement's result: the lookups must route through that
 *  entry, so the fetch stub below stays unused. */
const expectViaReplacedEdgeScript = async (
  call: () => Promise<unknown>,
  expected: unknown,
): Promise<void> => {
  const response = edgeScriptResponse(SINGLE_PULL_ZONE);
  await withMocks(
    () => stubFetch(new Response("Blocked", { status: 500 })),
    async () => {
      using _stub = stub(bunnyCdnApi, "getEdgeScript", () =>
        Promise.resolve({ data: response, ok: true }),
      );
      expect(await call()).toEqual(expected);
    },
  );
};

describeWithEnv(
  "getEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns edge script data on success", async () => {
      const response = edgeScriptResponse(SINGLE_PULL_ZONE);
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(response))),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({ data: response, ok: true });
        },
      );
    });

    test("returns error when API request fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Unauthorized", { status: 401 })),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            error: "Get edge script failed (401): Unauthorized",
            ok: false,
          });
        },
      );
    });

    test("extracts errorKey from JSON error response", async () => {
      const jsonBody = JSON.stringify({
        ErrorKey: "script.not_found",
        Message: "Script not found.",
      });
      await withMocks(
        () => stubFetch(new Response(jsonBody, { status: 404 })),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            error: "Get edge script failed (404): Script not found.",
            errorKey: "script.not_found",
            ok: false,
          });
        },
      );
    });
  },
);

describeWithEnv(
  "findPullZoneId",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns pull zone ID from first linked pull zone", async () => {
      const response = edgeScriptResponse(SINGLE_PULL_ZONE);
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(response))),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ id: 222, ok: true });
        },
      );
    });

    test("returns error when no linked pull zones", async () => {
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(edgeScriptResponse([])))),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            error: "Edge script 99 has no linked pull zones",
            ok: false,
          });
        },
      );
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Unauthorized", { status: 401 })),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            error: "Get edge script failed (401): Unauthorized",
            ok: false,
          });
        },
      );
    });

    test("goes through the bunnyCdnApi.getEdgeScript entry", async () => {
      await expectViaReplacedEdgeScript(() => bunnyCdnApi.findPullZoneId(), {
        id: 222,
        ok: true,
      });
    });
  },
);

describeWithEnv(
  "getCdnHostname",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    const expectCdnHostname = async (hostname: string): Promise<void> => {
      using _fetch = stubFetch(
        new Response(JSON.stringify(edgeScriptResponse([], hostname))),
      );
      const result = await bunnyCdnApi.getCdnHostname();
      expect(result).toEqual({ hostname: "mysite.b-cdn.net", ok: true });
    };

    test("converts .bunny.run hostname to .b-cdn.net", async () => {
      await expectCdnHostname("https://mysite.bunny.run");
    });

    test("passes through already-correct b-cdn.net hostname", async () => {
      await expectCdnHostname("mysite.b-cdn.net");
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Not found", { status: 404 })),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({
            error: "Get edge script failed (404): Not found",
            ok: false,
          });
        },
      );
    });

    test("goes through the bunnyCdnApi.getEdgeScript entry", async () => {
      await expectViaReplacedEdgeScript(() => bunnyCdnApi.getCdnHostname(), {
        hostname: "mysite.b-cdn.net",
        ok: true,
      });
    });
  },
);

describeWithEnv(
  "updatePullZone",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends POST to pull zone with settings payload", async () => {
      using fetchStub = stubFetch(new Response());
      const result = await bunnyCdnApi.updatePullZone(99, {
        DisableCookies: false,
      });
      expect(result.ok).toBe(true);
      expect(String(fetchStub.calls[0]!.args[0])).toBe(
        "https://api.bunny.net/pullzone/99",
      );
      const init = fetchStub.calls[0]!.args[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("content-type")).toBe(
        "application/json",
      );
      const body = JSON.parse(init.body as string);
      expect(body.DisableCookies).toBe(false);
    });

    test("returns error on API failure", async () => {
      using _fetch = stubFetch(new Response("Server Error", { status: 500 }));
      const result = await bunnyCdnApi.updatePullZone(99, {
        DisableCookies: false,
      });
      expectErrorResult(result, "Update pull zone failed");
    });
  },
);

/** What the domain setup sent: each request's path with its query, method,
 * and JSON body. */
const sentRequests = (
  fetchStub: ReturnType<typeof stubFetch>,
): [path: string, method: string, body: unknown][] =>
  fetchStub.calls.map(({ args }) => {
    const init = args[1] as RequestInit;
    const url = new URL(String(args[0]));
    return [
      `${url.pathname}${url.search}`,
      String(init.method),
      init.body === undefined ? null : JSON.parse(String(init.body)),
    ];
  });

const NO_CONTENT = () => new Response(null, { status: 204 });

/** Replies that succeed once or more and then fail. */
const afterSuccesses = (
  count: number,
  failure: Response,
): [Response, ...Response[]] => [
  NO_CONTENT(),
  ...Array.from({ length: count - 1 }, NO_CONTENT),
  failure,
];

describeWithEnv(
  "validateCustomDomain",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    const fixedPullZone = {
      findPullZoneId: () => Promise.resolve({ id: 12345, ok: true as const }),
    };

    test("adds the hostname, loads a free certificate, and forces SSL, in that order", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        using fetchStub = stubFetch(NO_CONTENT());

        expect(
          await bunnyCdnApi.validateCustomDomain("cdn.example.com"),
        ).toEqual({ ok: true });
        expect(sentRequests(fetchStub)).toEqual([
          [
            "/pullzone/12345/addHostname",
            "POST",
            { Hostname: "cdn.example.com" },
          ],
          [
            "/pullzone/loadFreeCertificate?hostname=cdn.example.com",
            "GET",
            null,
          ],
          [
            "/pullzone/12345/setForceSSL",
            "POST",
            { ForceSSL: true, Hostname: "cdn.example.com" },
          ],
        ]);
      });
    });

    test("carries on after a hostname that is already registered, and stops on any other error key", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        const failure = (errorKey: string) =>
          new Response(JSON.stringify({ ErrorKey: errorKey, Message: "No." }), {
            status: 400,
          });
        using registered = stubFetch(
          failure("pullzone.hostname_already_registered"),
          NO_CONTENT(),
          NO_CONTENT(),
        );
        expect(
          await bunnyCdnApi.validateCustomDomain("cdn.example.com"),
        ).toEqual({ ok: true });
        expect(registered.calls).toHaveLength(3);
      });
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        using other = stubFetch(
          new Response(JSON.stringify({ ErrorKey: "", Message: "No." }), {
            status: 400,
          }),
        );
        expect(
          await bunnyCdnApi.validateCustomDomain("cdn.example.com"),
        ).toEqual({
          error: "Add hostname failed (400): No.",
          errorKey: "",
          ok: false,
        });
        expect(other.calls).toHaveLength(1);
      });
    });

    for (const [succeeding, message] of [
      [1, "Load free certificate failed (500): boom"],
      [2, "Set force SSL failed (500): boom"],
    ] as const) {
      test(`names the step that failed: ${message}`, async () => {
        await withMockBunnyCdnApi(fixedPullZone, async () => {
          using _fetch = stubFetch(
            ...afterSuccesses(
              succeeding,
              new Response("boom", { status: 500 }),
            ),
          );

          expect(
            await bunnyCdnApi.validateCustomDomain("cdn.example.com"),
          ).toEqual({ error: message, ok: false });
        });
      });
    }
  },
);
