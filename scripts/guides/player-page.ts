/**
 * The HTML shell around the three.js renderer. Only the video build loads this
 * page: it seeks the timeline frame by frame and screenshots each result. The
 * deployed app never serves it, and the CDN holds the finished MP4.
 */

import { escapeHtml } from "#jsx/escape-html.ts";

export interface PlayerPageOptions {
  guideTitle: string;
  scriptSrc: string;
}

export const playerPage = ({
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
    background: #000;
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
<script type="module" src="${escapeHtml(scriptSrc)}"></script>
</body>
</html>
`;
