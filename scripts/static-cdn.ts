import { sha256Hex } from "#scripts/checksum.ts";

export interface StaticCdnConfig {
  accountKey: string;
  cdnUrl: string;
  pullZoneId: string;
  storageHost: string;
  storageKey: string;
  storageName: string;
}

export interface StaticCdnAsset {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface PublishedStaticAssets {
  origin: string;
  urls: Record<string, string>;
}

const CDN_ENV_KEYS = [
  "CDN_URL",
  "CDN_BUNNY_STORAGE_ZONE_NAME",
  "CDN_BUNNY_STORAGE_ZONE_KEY",
  "CDN_BUNNY_STORAGE_HOST",
  "CDN_BUNNY_PULL_ZONE_ID",
] as const;
const BUNNY_STORAGE_HOSTS = [
  "storage.bunnycdn.com",
  "uk.storage.bunnycdn.com",
  "ny.storage.bunnycdn.com",
  "la.storage.bunnycdn.com",
  "sg.storage.bunnycdn.com",
  "se.storage.bunnycdn.com",
  "br.storage.bunnycdn.com",
  "jh.storage.bunnycdn.com",
  "syd.storage.bunnycdn.com",
] as const;
export const STATIC_CDN_REQUEST_TIMEOUT_MS = 30_000;

export const cleanCdnUrl = (raw: string): string => {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("CDN_URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CDN_URL must be a clean HTTPS base URL");
  }
  return url.toString().replace(/\/+$/, "");
};

export const loadStaticCdnConfig = (
  env: Record<string, string | undefined>,
): StaticCdnConfig | null => {
  const values = CDN_ENV_KEYS.map((key) => {
    const value = env[key];
    return value === undefined ? "" : value.trim();
  });
  const present = values.filter(Boolean).length;
  if (present === 0) return null;
  if (present !== CDN_ENV_KEYS.length) {
    throw new Error(`${CDN_ENV_KEYS.join(", ")} must all be set together`);
  }
  const rawAccountKey = env.BUNNY_ACCESS_KEY;
  if (rawAccountKey === undefined) {
    throw new Error("BUNNY_ACCESS_KEY is required to purge the static CDN");
  }
  const accountKey = rawAccountKey.trim();
  if (accountKey === "") {
    throw new Error("BUNNY_ACCESS_KEY is required to purge the static CDN");
  }

  const [cdnUrl, storageName, storageKey, storageHost, pullZoneId] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!BUNNY_STORAGE_HOSTS.some((host) => host === storageHost)) {
    throw new Error(
      `CDN_BUNNY_STORAGE_HOST must be one of: ${BUNNY_STORAGE_HOSTS.join(", ")}`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(storageName)) {
    throw new Error("CDN_BUNNY_STORAGE_ZONE_NAME must be a storage zone name");
  }
  if (!/^\d+$/.test(pullZoneId)) {
    throw new Error("CDN_BUNNY_PULL_ZONE_ID must be numeric");
  }
  return {
    accountKey,
    cdnUrl: cleanCdnUrl(cdnUrl),
    pullZoneId,
    storageHost,
    storageKey,
    storageName,
  };
};

const checkedFetch = async (
  fetcher: typeof fetch,
  input: string,
  init: RequestInit | undefined,
  failure: string,
): Promise<Response> => {
  const signals = [
    AbortSignal.timeout(STATIC_CDN_REQUEST_TIMEOUT_MS),
    init?.signal,
  ].filter(
    (signal): signal is AbortSignal => signal !== null && signal !== undefined,
  );
  const response = await fetcher(input, {
    ...init,
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) {
    throw new Error(`${failure}: HTTP ${response.status}`);
  }
  return response;
};

const purge = async (
  config: StaticCdnConfig,
  fetcher: typeof fetch,
): Promise<void> => {
  await checkedFetch(
    fetcher,
    `https://api.bunny.net/pullzone/${config.pullZoneId}/purgeCache`,
    {
      headers: { AccessKey: config.accountKey },
      method: "POST",
    },
    "Failed to purge static CDN",
  );
};

const releaseHash = async (assets: StaticCdnAsset[]): Promise<string> => {
  const encoder = new TextEncoder();
  const sorted = assets.toSorted((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  const parts = sorted.flatMap((asset) => [
    encoder.encode(
      `${asset.filename}\0${asset.contentType}\0${asset.bytes.length}\0`,
    ),
    asset.bytes,
  ]);
  const bytes = await new Blob(
    parts.map((part) => Uint8Array.from(part).buffer),
  ).arrayBuffer();
  return sha256Hex(new Uint8Array(bytes));
};

const publicUrl = (
  config: StaticCdnConfig,
  releasePath: string,
  filename: string,
): string => `${config.cdnUrl}/${releasePath}/${filename}`;

/** A media type without its parameters, lower-cased for comparison. */
const bareMediaType = (value: string): string =>
  value.replace(/;.*$/, "").trim().toLowerCase();

/** The per-asset upload and verify steps for one publish run, bound to its
 * config and fetch so the two steps share their plumbing — the request path
 * and the "Failed to <action> static CDN asset <name>" failure shape. */
const createAssetSteps = (config: StaticCdnConfig, fetcher: typeof fetch) => {
  const fetchAssetOrThrow = (
    action: "upload" | "verify",
    asset: StaticCdnAsset,
    url: string,
    init?: RequestInit,
  ): Promise<Response> =>
    checkedFetch(
      fetcher,
      url,
      init,
      `Failed to ${action} static CDN asset ${asset.filename}`,
    );

  const upload = async (
    objectPath: string,
    asset: StaticCdnAsset,
  ): Promise<void> => {
    await fetchAssetOrThrow(
      "upload",
      asset,
      `https://${config.storageHost}/${config.storageName}/${objectPath}`,
      {
        body: asset.bytes as BodyInit,
        headers: {
          AccessKey: config.storageKey,
          Checksum: (await sha256Hex(asset.bytes)).toUpperCase(),
          "Content-Type": asset.contentType,
        },
        method: "PUT",
      },
    );
  };

  const verify = async (url: string, asset: StaticCdnAsset): Promise<void> => {
    const response = await fetchAssetOrThrow("verify", asset, url);
    const contentType = response.headers.get("content-type");
    if (contentType === null) {
      throw new Error(
        `Static CDN asset ${asset.filename} is missing its content type`,
      );
    }
    const servedMediaType = bareMediaType(contentType);
    const expectedMediaType = bareMediaType(asset.contentType);
    if (servedMediaType !== expectedMediaType) {
      throw new Error(
        `Static CDN asset ${asset.filename} has content type ${servedMediaType}; expected ${expectedMediaType}`,
      );
    }
    const served = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(served)) !== (await sha256Hex(asset.bytes))) {
      throw new Error(
        `Static CDN asset ${asset.filename} does not match the uploaded file`,
      );
    }
  };

  return { upload, verify };
};

/** Run one per-asset step (upload or verify) over every asset in parallel. */
const forEveryAsset = async (
  assets: StaticCdnAsset[],
  step: (asset: StaticCdnAsset) => Promise<void>,
): Promise<void> => {
  await Promise.all(assets.map(step));
};

export const publishStaticCdnAssets = async (
  config: StaticCdnConfig,
  assets: StaticCdnAsset[],
  fetcher: typeof fetch = fetch,
): Promise<PublishedStaticAssets> => {
  const filenames = new Set(assets.map((asset) => asset.filename));
  if (filenames.size !== assets.length) {
    throw new Error("Static CDN asset filenames must be unique");
  }
  const version = await releaseHash(assets);
  const releasePath = `assets/${version}`;
  const storageBase = new URL(config.cdnUrl).pathname.replace(/^\/|\/$/g, "");
  const storagePath = storageBase
    ? `${storageBase}/${releasePath}`
    : releasePath;
  const steps = createAssetSteps(config, fetcher);
  await forEveryAsset(assets, (asset) =>
    steps.upload(`${storagePath}/${asset.filename}`, asset),
  );
  await purge(config, fetcher);
  await forEveryAsset(assets, (asset) =>
    steps.verify(publicUrl(config, releasePath, asset.filename), asset),
  );
  return {
    origin: new URL(config.cdnUrl).origin,
    urls: Object.fromEntries(
      assets.map((asset) => [
        asset.filename,
        publicUrl(config, releasePath, asset.filename),
      ]),
    ),
  };
};
