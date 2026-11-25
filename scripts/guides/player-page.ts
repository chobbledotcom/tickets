/**
 * The HTML shell around the three.js player. The same page serves the local
 * MP4 render and the CDN iframe; the CDN copy adds the autoplay flag.
 */

import { escapeHtml } from "#jsx/escape-html.ts";

export interface PlayerPageOptions {
  autoplay: boolean;
  guideTitle: string;
  scriptSrc: string;
}

export const playerPage = ({
  autoplay,
  guideTitle,
  scriptSrc,
}: PlayerPageOptions): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guideTitle)}</title>
<style>
  html, body {
    background: ${autoplay ? "transparent" : "#000"};
    margin: 0;
    overflow: hidden;
  }
  #stage { display: block; height: auto; width: 100%; }
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
${autoplay ? "<script>globalThis.__GUIDE_AUTOPLAY__ = true;</script>" : ""}
<script type="module" src="${escapeHtml(scriptSrc)}"></script>
</body>
</html>
`;
