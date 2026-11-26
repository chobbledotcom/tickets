#!/usr/bin/env -S deno run --allow-env=BUNNY_ACCESS_KEY,BUNNY_API_KEY,STAGING_STORAGE_ZONE_NAME,STAGING_STORAGE_ZONE_KEY,HOST_EMAIL_PROVIDER,HOST_EMAIL_API_KEY,HOST_EMAIL_FROM_ADDRESS --allow-read --allow-net=api.bunny.net

import { getRandomBytes, toBase64 } from "#crypto/utils.ts";
import { fetchText } from "#scripts/fetch-text.ts";
import { runPreview } from "#scripts/preview/run.ts";
import { runDenoScript } from "#scripts/script-runner.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";

/** The 32-byte base64 key that every site needs for its database. */
const newEncryptionKey = (): string => toBase64(getRandomBytes(32));

await runDenoScript((io) =>
  runPreview({
    ...io,
    fetchText,
    newEncryptionKey,
    newScheduledTaskKey: generateScheduledTaskKey,
    readTextFile: (path) => Deno.readTextFile(path),
  }),
);
