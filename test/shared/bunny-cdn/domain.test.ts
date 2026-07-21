import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { buildSubdomainRecordName, bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";

const ENV = {
  BUNNY_API_KEY: "test-key",
  BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
  BUNNY_DNS_ZONE_ID: "7",
  BUNNY_SCRIPT_ID: "42",
};

const zone = (
  records: { Id: number; Name: string; Type: number; Value: string }[] = [],
) => ({
  Domain: "example.test",
  Id: 7,
  Records: records,
});

type Restorable = { restore(): void };

const stubPullZoneId = (
  stubs: Restorable[],
  result: { id: number; ok: true } | { error: string; ok: false } = {
    id: 9,
    ok: true,
  },
): void => {
  stubs.push(
    stub(bunnyCdnApi, "findPullZoneId", () => Promise.resolve(result)),
  );
};

const stubAvailableSubdomain = (
  stubs: Restorable[],
  target: { hostname: string; ok: true } | { error: string; ok: false } = {
    hostname: "child.b-cdn.net",
    ok: true,
  },
): void => {
  stubs.push(
    stub(bunnyCdnApi, "checkSubdomainAvailable", () =>
      Promise.resolve({
        available: true,
        fullDomain: "child.tickets.example.test",
        ok: true,
      }),
    ),
    stub(bunnyCdnApi, "getCdnHostname", () => Promise.resolve(target)),
  );
};

const noContent = (): Response => new Response(null, { status: 204 });

const stubCustomDomainRequests = (
  first = noContent(),
): ReturnType<typeof stubFetch> => stubFetch(first, noContent(), noContent());

describeWithEnv("Bunny domain API", { env: ENV }, () => {
  const stubs: Restorable[] = [];
  restoreStubsAfterEach(stubs);
  const errors = setupErrorSpy();

  test("loads a DNS zone with the configured credential", async () => {
    using fetchStub = stubFetch(new Response(JSON.stringify(zone())));

    expect(await bunnyCdnApi.getDnsZone()).toEqual({ ok: true, zone: zone() });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://api.bunny.net/dnszone/7");
    expect(init.headers).toEqual({ AccessKey: "test-key" });
    expect(init.method).toBeUndefined();
  });

  test("labels a DNS zone provider failure", async () => {
    using _fetch = stubFetch(new Response("failed", { status: 500 }));

    expect(await bunnyCdnApi.getDnsZone()).toEqual({
      error: "Get DNS zone failed (500): failed",
      ok: false,
    });
  });

  test("builds and checks the full subdomain name", async () => {
    stubs.push(
      stub(bunnyCdnApi, "getDnsZone", () =>
        Promise.resolve({
          ok: true,
          zone: zone([
            { Id: 1, Name: "used.tickets", Type: 2, Value: "target" },
          ]),
        }),
      ),
    );

    expect(buildSubdomainRecordName("used")).toBe("used.tickets");
    expect(await bunnyCdnApi.checkSubdomainAvailable("used")).toEqual({
      available: false,
      fullDomain: "used.tickets.example.test",
      ok: true,
    });
    expect(await bunnyCdnApi.checkSubdomainAvailable("free")).toEqual({
      available: true,
      fullDomain: "free.tickets.example.test",
      ok: true,
    });
  });

  test("returns a DNS lookup failure before checking records", async () => {
    stubs.push(
      stub(bunnyCdnApi, "getDnsZone", () =>
        Promise.resolve({ error: "zone failed", ok: false }),
      ),
    );
    expect(await bunnyCdnApi.checkSubdomainAvailable("free")).toEqual({
      error: "zone failed",
      ok: false,
    });
  });

  test("registers a custom hostname and enables forced SSL", async () => {
    stubPullZoneId(stubs);
    using fetchStub = stubCustomDomainRequests();

    expect(
      await bunnyCdnApi.validateCustomDomain("custom.example.test"),
    ).toEqual({ ok: true });
    const calls = fetchStub.calls.map(
      ({ args }) => args as [string, RequestInit],
    );
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.bunny.net/pullzone/9/addHostname",
      "https://api.bunny.net/pullzone/loadFreeCertificate?hostname=custom.example.test",
      "https://api.bunny.net/pullzone/9/setForceSSL",
    ]);
    expect(calls.map(([, init]) => init.method)).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      Hostname: "custom.example.test",
    });
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({
      ForceSSL: true,
      Hostname: "custom.example.test",
    });
    expect(new Headers(calls[0]![1].headers).get("content-type")).toBe(
      "application/json",
    );
  });

  test("continues when the custom hostname is already registered", async () => {
    stubPullZoneId(stubs);
    using _fetch = stubCustomDomainRequests(
      new Response(
        JSON.stringify({
          ErrorKey: "pullzone.hostname_already_registered",
          Message: "already registered",
        }),
        { status: 400 },
      ),
    );

    expect(
      await bunnyCdnApi.validateCustomDomain("custom.example.test"),
    ).toEqual({ ok: true });
  });

  test("reports a pull-zone lookup failure", async () => {
    stubPullZoneId(stubs, { error: "zone failed", ok: false });

    expect(
      await bunnyCdnApi.validateCustomDomain("custom.example.test"),
    ).toEqual({ error: "zone failed", ok: false });
    expect(errors.contains("zone failed")).toBe(true);
  });

  for (const [label, responses, expected] of [
    [
      "hostname",
      [new Response("add failed", { status: 500 })],
      "Add hostname failed (500): add failed",
    ],
    [
      "certificate",
      [
        new Response(null, { status: 204 }),
        new Response("cert failed", { status: 500 }),
      ],
      "Load free certificate failed (500): cert failed",
    ],
    [
      "forced SSL",
      [
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
        new Response("ssl failed", { status: 500 }),
      ],
      "Set force SSL failed (500): ssl failed",
    ],
  ] as const) {
    test(`reports a ${label} setup failure`, async () => {
      stubPullZoneId(stubs);
      using _fetch = stubFetch(responses[0], ...responses.slice(1));

      const result = await bunnyCdnApi.validateCustomDomain(
        "custom.example.test",
      );

      expect(result).toMatchObject({ error: expected, ok: false });
      expect(errors.contains(expected)).toBe(true);
    });
  }

  test("registers a CNAME with the exact DNS payload", async () => {
    stubAvailableSubdomain(stubs);
    stubs.push(
      stub(bunnyCdnApi, "validateCustomDomain", () =>
        Promise.resolve({ ok: true }),
      ),
    );
    using fetchStub = stubFetch(new Response(JSON.stringify({ Id: 12 })));

    expect(await bunnyCdnApi.registerBunnySubdomain("child")).toEqual({
      fullDomain: "child.tickets.example.test",
      ok: true,
    });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://api.bunny.net/dnszone/7/records");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      Name: "child.tickets",
      Ttl: 300,
      Type: 2,
      Value: "child.b-cdn.net",
    });
  });

  test("rejects a taken subdomain before provider writes", async () => {
    stubs.push(
      stub(bunnyCdnApi, "checkSubdomainAvailable", () =>
        Promise.resolve({
          available: false,
          fullDomain: "used.tickets.example.test",
          ok: true,
        }),
      ),
    );
    using fetchStub = stubFetch(() => {
      throw new Error("Unexpected provider request");
    });

    expect(await bunnyCdnApi.registerBunnySubdomain("used")).toEqual({
      error: 'Subdomain "used" is already taken',
      ok: false,
    });
    expect(fetchStub.calls.length).toBe(0);
  });

  test("reports a CDN target lookup failure", async () => {
    stubAvailableSubdomain(stubs, { error: "target failed", ok: false });

    expect(await bunnyCdnApi.registerBunnySubdomain("child")).toEqual({
      error: "target failed",
      ok: false,
    });
    expect(errors.contains("target failed")).toBe(true);
  });

  test("reports a DNS record write failure", async () => {
    stubAvailableSubdomain(stubs);
    using _fetch = stubFetch(new Response("write failed", { status: 500 }));

    expect(await bunnyCdnApi.registerBunnySubdomain("child")).toEqual({
      error: "Add DNS CNAME record failed (500): write failed",
      ok: false,
    });
    expect(errors.contains("Add DNS CNAME record failed")).toBe(true);
  });

  test("retries certificate setup with bounded backoff and cleans up", async () => {
    const delays: number[] = [];
    const validations: string[] = [];
    const deleted: [string, number][] = [];
    stubAvailableSubdomain(stubs);
    stubs.push(
      stub(bunnyCdnApi, "validateCustomDomain", (hostname) => {
        validations.push(hostname);
        return Promise.resolve({ error: "certificate pending", ok: false });
      }),
      stub(bunnyCdnApi, "delay", (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      }),
      stub(bunnyCdnApi, "deleteDnsRecord", (zoneId, recordId) => {
        deleted.push([zoneId, recordId]);
        return Promise.resolve({ ok: true });
      }),
    );
    using _fetch = stubFetch(new Response(JSON.stringify({ Id: 12 })));

    expect(await bunnyCdnApi.registerBunnySubdomain("child")).toEqual({
      error: "certificate pending",
      ok: false,
    });
    expect(validations).toEqual(Array(5).fill("child.tickets.example.test"));
    expect(delays).toEqual([5_000, 10_000, 15_000, 20_000]);
    expect(deleted).toEqual([["7", 12]]);
  });

  test("does not clean up an unknown DNS record id", async () => {
    const deleted: number[] = [];
    stubAvailableSubdomain(stubs);
    stubs.push(
      stub(bunnyCdnApi, "validateCustomDomain", () =>
        Promise.resolve({ error: "certificate pending", ok: false }),
      ),
      stub(bunnyCdnApi, "delay", () => Promise.resolve()),
      stub(bunnyCdnApi, "deleteDnsRecord", (_zoneId, recordId) => {
        deleted.push(recordId);
        return Promise.resolve({ ok: true });
      }),
    );
    using _fetch = stubFetch(new Response("not json"));

    await bunnyCdnApi.registerBunnySubdomain("child");

    expect(deleted).toEqual([]);
  });

  test("deletes a DNS record with the exact provider request", async () => {
    using fetchStub = stubFetch(new Response(null, { status: 204 }));

    expect(await bunnyCdnApi.deleteDnsRecord("7", 12)).toEqual({ ok: true });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://api.bunny.net/dnszone/7/records/12");
    expect(init.method).toBe("DELETE");
  });

  test("labels a DNS record delete failure", async () => {
    using _fetch = stubFetch(new Response("failed", { status: 500 }));
    expect(await bunnyCdnApi.deleteDnsRecord("7", 12)).toEqual({
      error: "Delete DNS record failed (500): failed",
      ok: false,
    });
  });
});
