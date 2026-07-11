export interface StaticCdnConfig {
  accountKey: string;
  cdnUrl: string;
  pullZoneId: string;
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
  "CDN_BUNNY_PULL_ZONE_ID",
] as const;

const STATIC_CDN_REQUEST_TIMEOUT_MS = 30_000;

const cleanCdnUrl = (raw: string): string => {
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

  const [cdnUrl, storageName, storageKey, pullZoneId] = values as [
    string,
    string,
    string,
    string,
  ];
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

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const checksum = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));

const releaseHash = async (assets: StaticCdnAsset[]): Promise<string> => {
  const encoder = new TextEncoder();
  const sorted = assets.toSorted((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  const parts = sorted.flatMap((asset) => [
    encoder.encode(`${asset.filename}\0${asset.bytes.length}\0`),
    asset.bytes,
  ]);
  const bytes = await new Blob(
    parts.map((part) => Uint8Array.from(part).buffer),
  ).arrayBuffer();
  return checksum(new Uint8Array(bytes));
};

const upload = async (
  config: StaticCdnConfig,
  objectPath: string,
  asset: StaticCdnAsset,
  fetcher: typeof fetch,
): Promise<void> => {
  await checkedFetch(
    fetcher,
    `https://storage.bunnycdn.com/${config.storageName}/${objectPath}`,
    {
      body: asset.bytes as BodyInit,
      headers: {
        AccessKey: config.storageKey,
        Checksum: (await checksum(asset.bytes)).toUpperCase(),
        "Content-Type": asset.contentType,
      },
      method: "PUT",
    },
    `Failed to upload static CDN asset ${asset.filename}`,
  );
};

const publicUrl = (
  config: StaticCdnConfig,
  releasePath: string,
  filename: string,
): string => `${config.cdnUrl}/${releasePath}/${filename}`;

const verify = async (
  url: string,
  asset: StaticCdnAsset,
  fetcher: typeof fetch,
): Promise<void> => {
  const response = await checkedFetch(
    fetcher,
    url,
    undefined,
    `Failed to verify static CDN asset ${asset.filename}`,
  );
  const served = new Uint8Array(await response.arrayBuffer());
  if ((await checksum(served)) !== (await checksum(asset.bytes))) {
    throw new Error(
      `Static CDN asset ${asset.filename} does not match the uploaded file`,
    );
  }
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
  await Promise.all(
    assets.map((asset) =>
      upload(config, `${storagePath}/${asset.filename}`, asset, fetcher),
    ),
  );
  await purge(config, fetcher);
  await Promise.all(
    assets.map((asset) =>
      verify(publicUrl(config, releasePath, asset.filename), asset, fetcher),
    ),
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
