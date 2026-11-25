/** Serve the renderer page, its bundle, the timeline, and the recorded frames
 * from a loopback address. Nothing outside the recording is reachable. */

import { join } from "@std/path";
import {
  defineLoopbackServer,
  type LoopbackServer,
} from "#scripts/loopback-server.ts";
import { playerPage } from "../player-page.ts";
import { bundleGuideRenderer } from "./bundle.ts";

const FRAME_PATTERN = /^\/frames\/(frame-\d{5}\.jpg)$/;

const textResponse = (body: string, contentType: string): Response =>
  new Response(body, { headers: { "content-type": contentType } });

export const startGuideRenderServer = async (
  sessionDir: string,
  guideTitle: string,
): Promise<LoopbackServer> => {
  const [bundle, timeline] = await Promise.all([
    bundleGuideRenderer(),
    Deno.readTextFile(join(sessionDir, "timeline.json")),
  ]);
  const page = playerPage({
    autoplay: false,
    guideTitle,
    scriptSrc: "/renderer.js",
  });
  return defineLoopbackServer((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return textResponse(page, "text/html; charset=utf-8");
    }
    if (url.pathname === "/renderer.js") {
      return textResponse(bundle, "text/javascript; charset=utf-8");
    }
    if (url.pathname === "/timeline.json") {
      return textResponse(timeline, "application/json; charset=utf-8");
    }
    const frame = FRAME_PATTERN.exec(url.pathname);
    if (frame) {
      return Deno.readFile(join(sessionDir, frame[1]!))
        .then(
          (bytes) =>
            new Response(bytes, {
              headers: { "content-type": "image/jpeg" },
            }),
        )
        .catch(() => new Response("Frame not found", { status: 404 }));
    }
    return new Response("Not found", { status: 404 });
  })();
};
