/// <reference lib="dom" />
/**
 * Logistics map loader: injects the separate `/logistics-map.js` bundle (and
 * Leaflet's stylesheet) when the page has a logistics map container. Leaflet
 * is heavy, and only the attendee Logistics tab shows a map, so every other
 * admin page skips the download entirely.
 */

import { loadBundleWhen } from "./bundle-loader.ts";

export const initLogisticsMapLoader = (): void =>
  loadBundleWhen(
    "[data-logistics-map]",
    "/logistics-map.js",
    "/logistics-map.css",
  );
