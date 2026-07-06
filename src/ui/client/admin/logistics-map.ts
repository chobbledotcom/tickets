/// <reference lib="dom" />
/**
 * Logistics map behavior — shows a map pinned on the attendee's saved
 * latitude/longitude and re-pins live as the inputs change (typed by hand or
 * filled by the postcode search). The map itself comes from an injected
 * library (Leaflet, adapted in `../logistics-map.ts`), so this module owns
 * only the DOM wiring and stays testable without a real map.
 *
 * The container starts hidden when the attendee has no pin; the first valid
 * pair reveals it and creates the map, and clearing the inputs hides it
 * again.
 */

import { findPinInputs } from "./pin-inputs.ts";

/** A live map showing one pin. */
export type LogisticsMap = {
  /** Move the pin (and the view) to a new spot. */
  moveTo(lat: number, lng: number): void;
  /** Re-measure the container (needed right after it is unhidden). */
  refreshSize(): void;
};

/** The one thing the map library must know how to do. */
export type MapLibrary = {
  createMap(element: HTMLElement, lat: number, lng: number): LogisticsMap;
};

/** Parse the lat/lng input values into map coordinates, or null when they
 * don't point anywhere (blank, non-numeric, or off the globe). */
export const readMapPin = (
  lat: string,
  lng: string,
): [number, number] | null => {
  const latNumber = Number(lat.trim() || "NaN");
  const lngNumber = Number(lng.trim() || "NaN");
  if (!Number.isFinite(latNumber) || !Number.isFinite(lngNumber)) return null;
  if (Math.abs(latNumber) > 90 || Math.abs(lngNumber) > 180) return null;
  return [latNumber, lngNumber];
};

/** Wire the page's logistics map container to its lat/lng inputs. */
export const initLogisticsMap = (library: MapLibrary): void => {
  const container = document.querySelector<HTMLElement>("[data-logistics-map]");
  const inputs = findPinInputs();
  if (!container || !inputs) return;
  const { latInput, lngInput } = inputs;

  let map: LogisticsMap | null = null;
  const update = (): void => {
    const pin = readMapPin(latInput.value, lngInput.value);
    if (!pin) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    if (map) {
      map.refreshSize();
      map.moveTo(pin[0], pin[1]);
    } else {
      map = library.createMap(container, pin[0], pin[1]);
    }
  };
  latInput.addEventListener("input", update);
  lngInput.addEventListener("input", update);
  update();
};
