/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";
/* jscpd:ignore-end */
import { expectErrorResult } from "./bunny/fixtures.ts";

/** Build an edge script API response */
const edgeScriptResponse = (
  pullZones: {
    Id: number;
    PullZoneName: string;
    DefaultHostname: string;
  }[] = [],
  defaultHostname = "mysite.b-cdn.net",
) => ({
  DefaultHostname: defaultHostname,
  Id: 1,
  LinkedPullZones: pullZones,
});

/** The single linked pull zone most edge-script tests exercise. */
const SINGLE_PULL_ZONE = [
  { DefaultHostname: "mysite.b-cdn.net", Id: 222, PullZoneName: "mysite" },
];

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
