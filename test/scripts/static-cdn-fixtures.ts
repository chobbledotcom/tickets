import type {
  StaticCdnAsset,
  StaticCdnConfig,
} from "../../scripts/static-cdn.ts";

export const CONFIG = {
  accountKey: "account-secret",
  cdnUrl: "https://assets.example.com/static",
  pullZoneId: "12345",
  storageHost: "storage.bunnycdn.com",
  storageKey: "storage-secret",
  storageName: "tickets-assets",
} satisfies StaticCdnConfig;

export const ENV = {
  BUNNY_ACCESS_KEY: "account-secret",
  CDN_BUNNY_PULL_ZONE_ID: "12345",
  CDN_BUNNY_STORAGE_HOST: "storage.bunnycdn.com",
  CDN_BUNNY_STORAGE_ZONE_KEY: "storage-secret",
  CDN_BUNNY_STORAGE_ZONE_NAME: "tickets-assets",
  CDN_URL: "https://assets.example.com/static/",
};

export const STYLE_ASSET = {
  bytes: new TextEncoder().encode("body{}"),
  contentType: "text/css; charset=utf-8",
  filename: "style.css",
} satisfies StaticCdnAsset;

export const WASM_ASSET = {
  bytes: new Uint8Array([0, 97, 115, 109]),
  contentType: "application/wasm",
  filename: "jpegDec.wasm",
} satisfies StaticCdnAsset;

export const assetResponse = (asset: StaticCdnAsset): Response =>
  new Response(Uint8Array.from(asset.bytes).buffer, {
    headers: { "content-type": asset.contentType },
  });

export const successfulFetcher =
  (assetForUrl: (url: string) => StaticCdnAsset): typeof fetch =>
  (input, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    const url = String(input);
    return Promise.resolve(assetResponse(assetForUrl(url)));
  };

export const verificationFetcher =
  (publicResponse: Response): typeof fetch =>
  (_input, init) =>
    Promise.resolve(
      init?.method === "PUT"
        ? new Response(null, { status: 201 })
        : init?.method === "POST"
          ? new Response(null, { status: 204 })
          : publicResponse,
    );
