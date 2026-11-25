/** Serve the renderer page, its bundle, the timeline, and the recorded frames
 * from a loopback address. Nothing outside the recording is reachable. */

import { join } from "@std/path";
import {
  defineLoopbackServer,
  type LoopbackServer,
} from "#scripts/loopback-server.ts";
import { bundleGuideRenderer } from "./bundle.ts";

const FRAME_PATTERN = /^\/frames\/(frame-\d{5}\.jpg)$/;

const textResponse = (body: string, contentType: string): Response =>
  new Response(body, { headers: { "content-type": contentType } });

const page = (viewport: {
  height: number;
  width: number;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Guide renderer</title>
<style>
  html, body {
    background: #000;
    height: ${viewport.height}px;
    margin: 0;
    overflow: hidden;
    width: ${viewport.width}px;
  }
  #stage { display: block; height: ${viewport.height}px; width: ${viewport.width}px; }
  #cursor { left: 0; opacity: 0; pointer-events: none; position: fixed; top: 0; }
  #cursor span {
    border: 2px solid rgba(255, 255, 255, 0.9);
    border-radius: 50%;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35);
    height: 28px;
    left: -14px;
    position: absolute;
    top: -14px;
    width: 28px;
  }
  #cursor::after {
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
    content: "";
    height: 6px;
    left: -3px;
    position: absolute;
    top: -3px;
    width: 6px;
  }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="cursor"><span></span></div>
<script type="module" src="/renderer.js"></script>
</body>
</html>
`;

export const startGuideRenderServer = async (
  sessionDir: string,
  viewport: { height: number; width: number },
): Promise<LoopbackServer> => {
  const [bundle, timeline] = await Promise.all([
    bundleGuideRenderer(),
    Deno.readTextFile(join(sessionDir, "timeline.json")),
  ]);
  return defineLoopbackServer((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return textResponse(page(viewport), "text/html; charset=utf-8");
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
