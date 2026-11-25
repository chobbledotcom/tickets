import pLimit from "promise-limit";
import { sha256Hex } from "#shared/sha256.ts";

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

/** One object in the CDN storage zone. The path is relative to the zone root
 * and may carry directories. `label` names the object in an error when the
 * caller wants a shorter name than the full path. */
export interface CdnObject {
  bytes: Uint8Array;
  contentType: string;
  label?: string;
  path: string;
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

/** The hash of a set of CDN objects: sorted paths, content types, lengths, and
 * bytes. A content-addressed release names the same bytes in every run. */
export const cdnObjectsHash = async (
  objects: readonly CdnObject[],
): Promise<string> => {
  const encoder = new TextEncoder();
  const sorted = objects.toSorted((a, b) => a.path.localeCompare(b.path));
  const parts = sorted.flatMap((object) => [
    encoder.encode(
      `${object.path}\0${object.contentType}\0${object.bytes.length}\0`,
    ),
    object.bytes,
  ]);
  const bytes = await new Blob(
    parts.map((part) => Uint8Array.from(part).buffer),
  ).arrayBuffer();
  return sha256Hex(new Uint8Array(bytes));
};

/** A media type without its parameters, lower-cased for comparison. */
const bareMediaType = (value: string): string =>
  value.replace(/;.*$/, "").trim().toLowerCase();

/** The per-object upload and verify steps for one publish run, bound to its
 * config and fetch so the two steps share their plumbing. */
const createObjectSteps = (config: StaticCdnConfig, fetcher: typeof fetch) => {
  const objectName = (object: CdnObject): string => object.label ?? object.path;
  const fetchObjectOrThrow = (
    action: "upload" | "verify",
    object: CdnObject,
    url: string,
    init?: RequestInit,
  ): Promise<Response> =>
    checkedFetch(
      fetcher,
      url,
      init,
      `Failed to ${action} static CDN asset ${objectName(object)}`,
    );

  const upload = async (
    objectPath: string,
    object: CdnObject,
  ): Promise<void> => {
    await fetchObjectOrThrow(
      "upload",
      object,
      `https://${config.storageHost}/${config.storageName}/${objectPath}`,
      {
        body: object.bytes as BodyInit,
        headers: {
          AccessKey: config.storageKey,
          Checksum: (await sha256Hex(object.bytes)).toUpperCase(),
          "Content-Type": object.contentType,
        },
        method: "PUT",
      },
    );
  };

  const verify = async (url: string, object: CdnObject): Promise<void> => {
    const response = await fetchObjectOrThrow("verify", object, url);
    const contentType = response.headers.get("content-type");
    if (contentType === null) {
      throw new Error(
        `Static CDN asset ${objectName(object)} is missing its content type`,
      );
    }
    const servedMediaType = bareMediaType(contentType);
    const expectedMediaType = bareMediaType(object.contentType);
    if (servedMediaType !== expectedMediaType) {
      throw new Error(
        `Static CDN asset ${objectName(object)} has content type ${servedMediaType}; expected ${expectedMediaType}`,
      );
    }
    const served = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(served)) !== (await sha256Hex(object.bytes))) {
      throw new Error(
        `Static CDN asset ${objectName(object)} does not match the uploaded file`,
      );
    }
  };

  return { upload, verify };
};

const storageBaseFor = (config: StaticCdnConfig): string =>
  new URL(config.cdnUrl).pathname.replace(/^\/|\/$/g, "");

const storagePathFor = (
  config: StaticCdnConfig,
  objectPath: string,
): string => {
  const base = storageBaseFor(config);
  return base === "" ? objectPath : `${base}/${objectPath}`;
};

const publicUrlFor = (config: StaticCdnConfig, objectPath: string): string =>
  `${config.cdnUrl}/${objectPath}`;

/** The number of upload or verify requests one publish run keeps in flight. */
const CDN_CONCURRENCY = 8;

const runEveryObject = async (
  objects: readonly CdnObject[],
  limit: ReturnType<typeof pLimit>,
  run: (object: CdnObject) => Promise<void>,
): Promise<void> => {
  await Promise.all(objects.map((object) => limit(() => run(object))));
};

/** Publish objects under their given paths, purge the pull zone, and verify
 * every served object. The caller owns the paths and their stability. */
export const publishCdnObjects = async (
  config: StaticCdnConfig,
  objects: readonly CdnObject[],
  fetcher: typeof fetch = fetch,
): Promise<Record<string, string>> => {
  const paths = new Set(objects.map((object) => object.path));
  if (paths.size !== objects.length) {
    throw new Error("CDN object paths must be unique");
  }
  const steps = createObjectSteps(config, fetcher);
  const limit = pLimit(CDN_CONCURRENCY);
  await runEveryObject(objects, limit, (object) =>
    steps.upload(storagePathFor(config, object.path), object),
  );
  await purge(config, fetcher);
  await runEveryObject(objects, limit, (object) =>
    steps.verify(publicUrlFor(config, object.path), object),
  );
  return Object.fromEntries(
    objects.map((object) => [object.path, publicUrlFor(config, object.path)]),
  );
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
  const version = await cdnObjectsHash(
    assets.map((asset) => ({
      bytes: asset.bytes,
      contentType: asset.contentType,
      path: asset.filename,
    })),
  );
  const releasePath = `assets/${version}`;
  const urls = await publishCdnObjects(
    config,
    assets.map(({ bytes, contentType, filename }) => ({
      bytes,
      contentType,
      label: filename,
      path: `${releasePath}/${filename}`,
    })),
    fetcher,
  );
  return {
    origin: new URL(config.cdnUrl).origin,
    urls: Object.fromEntries(
      assets.map((asset) => [
        asset.filename,
        urls[`${releasePath}/${asset.filename}`]!,
      ]),
    ),
  };
};
