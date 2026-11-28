import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  type CdnObject,
  cdnObjectsHash,
  publishCdnObjects,
  publishStaticCdnAssets,
  type StaticCdnAsset,
} from "#scripts/static-cdn.ts";
import {
  assetResponse,
  CONFIG,
  STYLE_ASSET,
  successfulFetcher,
  verificationFetcher,
  WASM_ASSET,
} from "./static-cdn-fixtures.ts";

const GUIDE_OBJECTS: CdnObject[] = [
  {
    bytes: new TextEncoder().encode("console.log(1)"),
    contentType: "text/javascript; charset=utf-8",
    path: "guides/release/player.js",
  },
  {
    bytes: new TextEncoder().encode("<!doctype html>"),
    contentType: "text/html; charset=utf-8",
    path: "guides/release/create-a-listing/index.html",
  },
];

const guideObjectFor = (url: string): CdnObject => {
  const found = GUIDE_OBJECTS.find((object) => url.endsWith(object.path));
  if (!found) throw new Error(`Unexpected guide object URL ${url}`);
  return found;
};

/** A recording fetcher that answers each request through `respond`. */
const recordingFetcher =
  (
    requests: Request[],
    respond: (request: Request) => Response,
  ): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  };

/** The fake CDN's answer: an object for a GET, and success for a write. */
const guideCdnResponse = (request: Request): Response => {
  if (request.method === "GET") {
    const object = guideObjectFor(request.url);
    return new Response(Uint8Array.from(object.bytes).buffer, {
      headers: { "content-type": object.contentType },
    });
  }
  return new Response(null, { status: request.method === "PUT" ? 201 : 204 });
};

const STALLED_REQUESTS = [
  { method: "PUT", stage: "upload" },
  { method: "POST", stage: "purge" },
  { method: "GET", stage: "verification" },
] as const;

const styleOrWasm =
  (style: StaticCdnAsset) =>
  (url: string): StaticCdnAsset =>
    url.endsWith(STYLE_ASSET.filename) ? style : WASM_ASSET;

const completeRequest = successfulFetcher(() => STYLE_ASSET);

const rejectWhenAborted = (signal: AbortSignal): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

const stalledFetcher =
  (stalledMethod: string, onStart: () => void): typeof fetch =>
  (input, init) => {
    const method = init?.method ?? "GET";
    if (method !== stalledMethod) return completeRequest(input, init);
    const signal = init?.signal;
    if (!signal) throw new Error("Expected bounded Bunny request");
    const stalled = rejectWhenAborted(signal);
    onStart();
    return stalled;
  };

/** Both publishers must reject a duplicate path before any request. */
const expectDuplicateRejected = async (
  publish: (fetcher: typeof fetch) => Promise<unknown>,
): Promise<void> => {
  let requested = false;
  await expect(
    publish(() => {
      requested = true;
      return Promise.reject(new Error("Unexpected network request"));
    }),
  ).rejects.toThrow("must be unique");
  expect(requested).toBe(false);
};

describe("publishCdnObjects", () => {
  test("uploads each object under its own path and verifies it", async () => {
    const requests: Request[] = [];
    const published = await publishCdnObjects(
      CONFIG,
      GUIDE_OBJECTS,
      recordingFetcher(requests, guideCdnResponse),
    );

    expect(published).toEqual({
      "guides/release/create-a-listing/index.html":
        "https://assets.example.com/static/guides/release/create-a-listing/index.html",
      "guides/release/player.js":
        "https://assets.example.com/static/guides/release/player.js",
    });
    expect(
      requests.filter(({ method }) => method === "PUT").map(({ url }) => url),
    ).toEqual([
      "https://storage.bunnycdn.com/tickets-assets/static/guides/release/player.js",
      "https://storage.bunnycdn.com/tickets-assets/static/guides/release/create-a-listing/index.html",
    ]);
    expect(requests.find(({ method }) => method === "POST")?.url).toBe(
      "https://api.bunny.net/pullzone/12345/purgeCache",
    );
    expect(
      requests.filter(({ method }) => method === "GET").map(({ url }) => url),
    ).toEqual([
      "https://assets.example.com/static/guides/release/player.js",
      "https://assets.example.com/static/guides/release/create-a-listing/index.html",
    ]);
  });

  test("uses the object path directly when the CDN URL has no base path", async () => {
    const requests: Request[] = [];

    const published = await publishCdnObjects(
      { ...CONFIG, cdnUrl: "https://assets.example.com" },
      [GUIDE_OBJECTS[0]!],
      recordingFetcher(requests, guideCdnResponse),
    );

    expect(published).toEqual({
      "guides/release/player.js":
        "https://assets.example.com/guides/release/player.js",
    });
    expect(requests.find(({ method }) => method === "PUT")?.url).toBe(
      "https://storage.bunnycdn.com/tickets-assets/guides/release/player.js",
    );
  });

  test("rejects duplicate paths before uploading", async () => {
    await expectDuplicateRejected((fetcher) =>
      publishCdnObjects(
        CONFIG,
        [GUIDE_OBJECTS[0]!, GUIDE_OBJECTS[0]!],
        fetcher,
      ),
    );
  });

  test("hashes the same objects the same way in any order", async () => {
    const first = await cdnObjectsHash(GUIDE_OBJECTS);
    const reversed = await cdnObjectsHash([...GUIDE_OBJECTS].reverse());
    const changed = await cdnObjectsHash([
      { ...GUIDE_OBJECTS[0]!, bytes: new Uint8Array([1]) },
      GUIDE_OBJECTS[1]!,
    ]);

    expect(reversed).toBe(first);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("publishStaticCdnAssets", () => {
  test("uploads one immutable release and returns its public URLs", async () => {
    const requests: Request[] = [];
    const assetForUrl = styleOrWasm(STYLE_ASSET);
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const asset = assetForUrl(request.url);
      return Promise.resolve(
        request.method === "GET"
          ? assetResponse(asset)
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
      "https://assets.example.com/static/assets/d4632641703f36d87d3ae3a6fd8f4849ad16f9ff42795ad26f25c3fe42a8bf1e/style.css",
    );
    expect(published.urls["jpegDec.wasm"]).toBe(
      "https://assets.example.com/static/assets/d4632641703f36d87d3ae3a6fd8f4849ad16f9ff42795ad26f25c3fe42a8bf1e/jpegDec.wasm",
    );
    expect(requests.length).toBe(5);
    const cssUploadUrl =
      "https://storage.bunnycdn.com/tickets-assets/static/assets/" +
      "d4632641703f36d87d3ae3a6fd8f4849ad16f9ff42795ad26f25c3fe42a8bf1e/style.css";
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
      successfulFetcher(styleOrWasm(STYLE_ASSET)),
    );
    const reversed = await publishStaticCdnAssets(
      CONFIG,
      [WASM_ASSET, STYLE_ASSET],
      successfulFetcher(styleOrWasm(STYLE_ASSET)),
    );
    const changedStyle = {
      ...STYLE_ASSET,
      bytes: new TextEncoder().encode("x"),
    };
    const changed = await publishStaticCdnAssets(
      CONFIG,
      [changedStyle, WASM_ASSET],
      successfulFetcher(styleOrWasm(changedStyle)),
    );

    expect(reversed.urls).toEqual(original.urls);
    expect(changed.urls[STYLE_ASSET.filename]).not.toBe(
      original.urls[STYLE_ASSET.filename],
    );
  });

  test("release URLs change with content type", async () => {
    const changedType = {
      ...STYLE_ASSET,
      contentType: "text/x-css; charset=utf-8",
    };
    const original = await publishStaticCdnAssets(
      CONFIG,
      [STYLE_ASSET],
      successfulFetcher(() => STYLE_ASSET),
    );
    const changed = await publishStaticCdnAssets(
      CONFIG,
      [changedType],
      successfulFetcher(() => changedType),
    );

    expect(changed.urls[STYLE_ASSET.filename]).not.toBe(
      original.urls[STYLE_ASSET.filename],
    );
  });

  test("uploads through the configured regional Bunny host", async () => {
    let uploadUrl = "";
    await publishStaticCdnAssets(
      { ...CONFIG, storageHost: "uk.storage.bunnycdn.com" },
      [STYLE_ASSET],
      (input, init) => {
        const method = init?.method ?? "GET";
        if (method === "PUT") uploadUrl = String(input);
        return Promise.resolve(
          method === "GET"
            ? assetResponse(STYLE_ASSET)
            : new Response(null, { status: 201 }),
        );
      },
    );

    expect(uploadUrl).toMatch(
      /^https:\/\/uk\.storage\.bunnycdn\.com\/tickets-assets\/static\/assets\/[a-f0-9]{64}\/style\.css$/,
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
    await expectDuplicateRejected((fetcher) =>
      publishStaticCdnAssets(CONFIG, [asset, asset], fetcher),
    );
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
        verificationFetcher(
          new Response("different", {
            headers: { "content-type": STYLE_ASSET.contentType },
          }),
        ),
      ),
    ).rejects.toThrow("style.css does not match the uploaded file");
  });

  test("fails the build when the public content type differs", async () => {
    await expect(
      publishStaticCdnAssets(
        CONFIG,
        [STYLE_ASSET],
        verificationFetcher(
          new Response(STYLE_ASSET.bytes, {
            headers: { "content-type": "application/octet-stream" },
          }),
        ),
      ),
    ).rejects.toThrow(
      "Static CDN asset style.css has content type application/octet-stream; expected text/css",
    );
  });

  test("fails the build when the public content type is missing", async () => {
    await expect(
      publishStaticCdnAssets(
        CONFIG,
        [STYLE_ASSET],
        verificationFetcher(new Response(STYLE_ASSET.bytes)),
      ),
    ).rejects.toThrow("Static CDN asset style.css is missing its content type");
  });

  test("allows Bunny requests to complete before the deadline", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected bounded Bunny request");
      const response =
        init?.method === undefined
          ? assetResponse(STYLE_ASSET)
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
    assertStringIncludes(
      published.urls[STYLE_ASSET.filename] ?? "",
      "/style.css",
    );
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
        stalledFetcher(stalledMethod, () => started.resolve()),
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
