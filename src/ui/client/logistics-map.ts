/// <reference lib="dom" />
/**
 * Entry point for the logistics map bundle (`/logistics-map.js`).
 *
 * Leaflet is heavy and only the attendee Logistics tab shows a map, so it
 * ships as its own bundle, injected by the admin bundle's loader
 * (`admin/logistics-map-loader.ts`) together with `/logistics-map.css`
 * (Leaflet's own stylesheet, vendored in `src/ui/static/`). Map tiles come
 * from OpenStreetMap; the pin is a vector icon styled in the app stylesheet,
 * so no image assets ship with the bundle.
 */

// @ts-types="npm:@types/leaflet@^1.9.20"
import * as leaflet from "leaflet";
import {
  initLogisticsMap,
  type LogisticsMap,
  type MapLibrary,
} from "./admin/logistics-map.ts";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const PIN_ZOOM = 16;

/** The vector pin (styled by `.logistics-map-pin`); its tip is the spot. */
const pinIcon = (): leaflet.DivIcon =>
  leaflet.divIcon({
    className: "",
    html: '<div class="logistics-map-pin"></div>',
    iconAnchor: [0, 28],
    iconSize: [28, 28],
  });

const library: MapLibrary = {
  createMap: (element, lat, lng): LogisticsMap => {
    const map = leaflet.map(element).setView([lat, lng], PIN_ZOOM);
    leaflet
      .tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 })
      .addTo(map);
    const pin = leaflet.marker([lat, lng], { icon: pinIcon() }).addTo(map);
    return {
      moveTo: (newLat, newLng) => {
        pin.setLatLng([newLat, newLng]);
        map.setView([newLat, newLng], map.getZoom());
      },
      refreshSize: () => map.invalidateSize(),
    };
  },
};

initLogisticsMap(library);
