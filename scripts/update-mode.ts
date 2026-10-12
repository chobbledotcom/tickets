#!/usr/bin/env -S deno run --allow-env=BUNNY_ACCESS_KEY,BUNNY_API_KEY --allow-net=api.bunny.net
import { ACCESS_KEY_ERROR, getAccessKey } from "#scripts/deploy-edge-lib.ts";
import { fetchText } from "#scripts/fetch-text.ts";
import { delay } from "#shared/now.ts";
import { runUpdateMode, type UpdateModeIo } from "./update-mode-lib.ts";

/**
 * The entry the deploy workflows run around every site code update. The
 * caller grants the site host alongside api.bunny.net, because both waits
 * fetch the site's read-only page:
 *
 *   deno run --allow-env=BUNNY_ACCESS_KEY --allow-net=api.bunny.net,site.example \
 *     scripts/update-mode.ts <begin|end> <script-id> <site-url>
 */

const io: UpdateModeIo = {
  accessKey: getAccessKey((key) => Deno.env.get(key)) ?? "",
  fetchText,
  log: (line) => console.log(line),
  sleep: delay,
};

if (io.accessKey === "") {
  console.error(ACCESS_KEY_ERROR);
  Deno.exit(1);
}

Deno.exit(await runUpdateMode(Deno.args, io));
