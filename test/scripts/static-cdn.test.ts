import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  loadStaticCdnConfig,
  publishStaticCdnAssets,
} from "../../scripts/static-cdn.ts";

const CONFIG = {
  accountKey: "account-secret",
  cdnUrl: "https://assets.example.com/static",
  pullZoneId: "12345",
  storageKey: "storage-secret",
  storageName: "tickets-assets",
};
const ENV = {
  BUNNY_ACCESS_KEY: "account-secret",
  CDN_BUNNY_PULL_ZONE_ID: "12345",
  CDN_BUNNY_STORAGE_ZONE_KEY: "storage-secret",
  CDN_BUNNY_STORAGE_ZONE_NAME: "tickets-assets",
  CDN_URL: "https://assets.example.com/static/",
};
const STYLE_ASSET = {
  bytes: new TextEncoder().encode("body{}"),
  contentType: "text/css; charset=utf-8",
  filename: "style.css",
};
const WASM_ASSET = {
  bytes: new Uint8Array([0, 97, 115, 109]),
  contentType: "application/wasm",
  filename: "jpegDec.wasm",
};
const STALLED_REQUESTS = [
  { method: "PUT", stage: "upload" },
  { method: "POST", stage: "purge" },
  { method: "GET", stage: "verification" },
] as const;

const successfulFetcher =
  (assets: readonly (typeof STYLE_ASSET)[]): typeof fetch =>
  (input, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    const url = String(input);
    const asset = assets.find(({ filename }) => url.endsWith(`/${filename}`));
    if (!asset) throw new Error(`Unexpected public CDN URL: ${url}`);
    return Promise.resolve(new Response(asset.bytes));
  };

const verificationFetcher =
  (publicResponse: Response): typeof fetch =>
  (_input, init) =>
    Promise.resolve(
      init?.method === "PUT"
        ? new Response(null, { status: 201 })
        : init?.method === "POST"
          ? new Response(null, { status: 204 })
          : publicResponse,
    );

describe("loadStaticCdnConfig", () => {
  test("keeps builds self-contained when every CDN value is absent", () => {
    expect(loadStaticCdnConfig({})).toBeNull();
  });

  test("normalizes a complete CDN configuration", () => {
    expect(loadStaticCdnConfig(ENV)).toEqual(CONFIG);
  });

  test("normalizes repeated trailing slashes in the CDN base", () => {
    expect(
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: "https://assets.example.com/static///",
      }),
    ).toEqual(CONFIG);
  });

  test("rejects a partial CDN configuration", () => {
    expect(() =>
      loadStaticCdnConfig({ CDN_URL: "https://assets.example.com" }),
    ).toThrow(
      "CDN_URL, CDN_BUNNY_STORAGE_ZONE_NAME, CDN_BUNNY_STORAGE_ZONE_KEY, CDN_BUNNY_PULL_ZONE_ID must all be set together",
    );
  });

  test("rejects a CDN URL that is not a clean HTTPS base", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: "http://assets.example.com/static",
      }),
    ).toThrow("HTTPS");
  });

  const expectUncleanUrlRejected = (cdnUrl: string): void => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: cdnUrl,
      }),
    ).toThrow("clean HTTPS base");
  };

  test("rejects credentials in an HTTPS base", () => {
    expectUncleanUrlRejected("https://user@assets.example.com/static");
  });

  test("rejects a query string in an HTTPS base", () => {
    expectUncleanUrlRejected("https://assets.example.com/static?mutable=true");
  });

  test("rejects a fragment in an HTTPS base", () => {
    expectUncleanUrlRejected("https://assets.example.com/static#asset");
  });

  test("rejects unsafe storage and pull-zone names", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_BUNNY_PULL_ZONE_ID: "not-an-id",
        CDN_BUNNY_STORAGE_ZONE_NAME: "../assets",
      }),
    ).toThrow("storage zone");
  });

  test("rejects a non-numeric pull-zone id", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_BUNNY_PULL_ZONE_ID: "not-an-id",
      }),
    ).toThrow("must be numeric");
  });

  test("requires the account key used to purge a configured CDN", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, BUNNY_ACCESS_KEY: undefined }),
    ).toThrow("BUNNY_ACCESS_KEY is required to purge the static CDN");
  });

  test("rejects a whitespace-only account key", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, BUNNY_ACCESS_KEY: "   " }),
    ).toThrow("BUNNY_ACCESS_KEY is required to purge the static CDN");
  });
});

describe("publishStaticCdnAssets", () => {
  test("uploads one immutable release and returns its public URLs", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = request.url.endsWith(STYLE_ASSET.filename)
        ? STYLE_ASSET.bytes
        : WASM_ASSET.bytes;
      return Promise.resolve(
        request.method === "GET"
          ? new Response(body)
          : new Response(null, { status: 201 }),
      );
    };

    const published = await publishStaticCdnAssets(
      CONFIG,
      [STYLE_ASSET, WASM_ASSET],
      fetcher,
    );

    expect(published.origin).toBe("https://assets.example.com");
    expect(published.urls["style.css"]).toBe(
      "https://assets.example.com/static/assets/5a3cb7a61a83b08341ffe60fc6697818e1b4ecfba94a4df75f975f05c0368397/style.css",
    );
    expect(published.urls["jpegDec.wasm"]).toBe(
      "https://assets.example.com/static/assets/5a3cb7a61a83b08341ffe60fc6697818e1b4ecfba94a4df75f975f05c0368397/jpegDec.wasm",
    );
    expect(requests.length).toBe(5);
    const cssUploadUrl =
      "https://storage.bunnycdn.com/tickets-assets/static/assets/" +
      "5a3cb7a61a83b08341ffe60fc6697818e1b4ecfba94a4df75f975f05c0368397/style.css";
    const cssUpload = requests.find(({ url }) => url === cssUploadUrl);
    if (!cssUpload) throw new Error("Expected style.css upload request");
    expect(cssUpload.method).toBe("PUT");
    expect(cssUpload.headers.get("accesskey")).toBe("storage-secret");
    expect(cssUpload.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect(cssUpload.headers.get("checksum")).toBe(
      "7C98040A541657584690AE2A1CC3B42A8B53B159CC60C5D3ABBFECBAEAC6C94A",
    );
    expect(cssUpload.url).toBe(cssUploadUrl);
    expect(requests[2]?.url).toBe(
      "https://api.bunny.net/pullzone/12345/purgeCache",
    );
    expect(requests[2]?.method).toBe("POST");
    expect(requests[2]?.headers.get("accesskey")).toBe("account-secret");
    expect(requests[3]?.method).toBe("GET");
    expect(requests[3]?.url).toBe(published.urls[STYLE_ASSET.filename]);
    expect(requests[4]?.url).toBe(published.urls[WASM_ASSET.filename]);
  });

  test("release URLs ignore input order and change with content", async () => {
    const original = await publishStaticCdnAssets(
      CONFIG,
      [STYLE_ASSET, WASM_ASSET],
      successfulFetcher([STYLE_ASSET, WASM_ASSET]),
    );
    const reversed = await publishStaticCdnAssets(
      CONFIG,
      [WASM_ASSET, STYLE_ASSET],
      successfulFetcher([STYLE_ASSET, WASM_ASSET]),
    );
    const changedStyle = {
      ...STYLE_ASSET,
      bytes: new TextEncoder().encode("x"),
    };
    const changed = await publishStaticCdnAssets(
      CONFIG,
      [changedStyle, WASM_ASSET],
      successfulFetcher([changedStyle, WASM_ASSET]),
    );

    expect(reversed.urls).toEqual(original.urls);
    expect(changed.urls[STYLE_ASSET.filename]).not.toBe(
      original.urls[STYLE_ASSET.filename],
    );
  });

  test("fails the build when Bunny Storage rejects an upload", async () => {
    await expect(
      publishStaticCdnAssets(
        CONFIG,
        [
          {
            bytes: new Uint8Array([1]),
            contentType: "application/javascript",
            filename: "admin.js",
          },
        ],
        () => Promise.resolve(new Response("denied", { status: 401 })),
      ),
    ).rejects.toThrow("admin.js");
  });

  test("rejects duplicate filenames before uploading", async () => {
    const asset = {
      bytes: new Uint8Array([1]),
      contentType: "application/javascript",
      filename: "admin.js",
    };
    let requested = false;
    await expect(
      publishStaticCdnAssets(CONFIG, [asset, asset], () => {
        requested = true;
        return Promise.reject(new Error("Unexpected network request"));
      }),
    ).rejects.toThrow("must be unique");
    expect(requested).toBe(false);
  });

  test("fails the build when the pull-zone purge fails", async () => {
    await expect(
      publishStaticCdnAssets(
        { ...CONFIG, cdnUrl: "https://assets.example.com" },
        [],
        (input) =>
          Promise.resolve(
            new Response(null, {
              status: String(input).includes("purgeCache") ? 503 : 201,
            }),
          ),
      ),
    ).rejects.toThrow("Failed to purge static CDN: HTTP 503");
  });

  test("fails the build when a public CDN asset is unavailable", async () => {
    await expect(
      publishStaticCdnAssets(
        CONFIG,
        [STYLE_ASSET],
        verificationFetcher(new Response(null, { status: 404 })),
      ),
    ).rejects.toThrow("style.css: HTTP 404");
  });

  test("fails the build when public CDN bytes differ", async () => {
    await expect(
      publishStaticCdnAssets(
        CONFIG,
        [STYLE_ASSET],
        verificationFetcher(new Response("different")),
      ),
    ).rejects.toThrow("style.css does not match the uploaded file");
  });

  test("allows Bunny requests to complete before the deadline", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected bounded Bunny request");
      const response =
        init?.method === undefined
          ? new Response(STYLE_ASSET.bytes)
          : new Response(null, { status: 201 });
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        }, 5);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };

    const published = await publishStaticCdnAssets(
      CONFIG,
      [STYLE_ASSET],
      fetcher,
    );
    expect(published.urls[STYLE_ASSET.filename]).toContain("/style.css");
  });

  for (const { method: stalledMethod, stage } of STALLED_REQUESTS) {
    test(`aborts a stalled ${stage} request after 30 seconds`, async () => {
      using time = new FakeTime();
      const started = Promise.withResolvers<void>();
      let error: unknown;
      let settled = false;
      const publishing = publishStaticCdnAssets(
        CONFIG,
        [STYLE_ASSET],
        (_input, init) => {
          const method = init?.method ?? "GET";
          if (method !== stalledMethod) {
            return Promise.resolve(
              method === "GET"
                ? new Response(STYLE_ASSET.bytes)
                : new Response(null, { status: 201 }),
            );
          }
          const signal = init?.signal;
          if (!signal) throw new Error("Expected bounded Bunny request");
          const stalled = new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          started.resolve();
          return stalled;
        },
      );
      const observed = publishing
        .catch((caught: unknown) => {
          error = caught;
        })
        .finally(() => {
          settled = true;
        });

      await started.promise;
      await time.tickAsync(29_999);
      expect(settled).toBe(false);
      await time.tickAsync(1);
      await observed;
      if (!(error instanceof DOMException)) {
        throw new Error(`Expected ${stage} timeout DOMException`);
      }
      expect(error.name).toBe("TimeoutError");
    });
  }
});
