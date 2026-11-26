#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

import { getRandomBytes, toBase64 } from "#crypto/utils.ts";
import { fetchText } from "#scripts/fetch-text.ts";
import { runPreview } from "#scripts/preview/run.ts";
import { runDenoScript } from "#scripts/script-runner.ts";
import { delay } from "#shared/now.ts";
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
    send: (request) => fetch(new Request(request, { redirect: "manual" })),
    sleep: delay,
  }),
);
