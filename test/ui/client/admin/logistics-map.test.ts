/**
 * Logistics map client behavior: the map appears when the lat/lng inputs
 * hold a real location, re-pins as they change, and hides when they are
 * cleared. The map library is a test double — this exercises the DOM wiring
 * (`src/ui/client/admin/logistics-map.ts`), not Leaflet itself.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  initLogisticsMap,
  type LogisticsMap,
  type MapLibrary,
  readMapPin,
} from "#src/ui/client/admin/logistics-map.ts";
import { initLogisticsMapLoader } from "#src/ui/client/admin/logistics-map-loader.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

afterEach(cleanup);

describe("readMapPin", () => {
  test("parses a valid pair into numbers", () => {
    expect(readMapPin("51.503396", "-0.127640")).toEqual([51.503396, -0.12764]);
  });

  test("returns null for blanks, non-numbers, and off-globe values", () => {
    expect(readMapPin("", "")).toBeNull();
    expect(readMapPin("51.5", "")).toBeNull();
    expect(readMapPin("north", "0")).toBeNull();
    expect(readMapPin("90.1", "0")).toBeNull();
    expect(readMapPin("0", "-180.1")).toBeNull();
  });

  test("accepts the extreme corners of the world", () => {
    expect(readMapPin("90", "-180")).toEqual([90, -180]);
  });
});

/** A recording fake map library. */
const fakeLibrary = () => {
  const calls: string[] = [];
  const map: LogisticsMap = {
    moveTo: (lat, lng) => calls.push(`moveTo ${lat},${lng}`),
    refreshSize: () => calls.push("refreshSize"),
  };
  const library: MapLibrary = {
    createMap: (_element, lat, lng) => {
      calls.push(`createMap ${lat},${lng}`);
      return map;
    },
  };
  return { calls, library };
};

const PAGE = (lat: string, lng: string): string =>
  `<div data-logistics-map hidden></div>
   <input name="lat" value="${lat}"><input name="lng" value="${lng}">`;

/** Install the page, run the enhancement, and hand back the pieces. */
const setup = (lat: string, lng: string) => {
  const window = installDom(PAGE(lat, lng));
  const { calls, library } = fakeLibrary();
  initLogisticsMap(library);
  const doc = window.document;
  const setInput = (name: string, value: string): void => {
    const input = doc.querySelector(`input[name="${name}"]`)!;
    input.setAttribute("value", value);
    (input as unknown as { value: string }).value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  return {
    calls,
    container: doc.querySelector("[data-logistics-map]")!,
    setInput,
  };
};

describe("initLogisticsMap", () => {
  test("creates the map and reveals the container for a saved pin", () => {
    const { calls, container } = setup("51.5", "-0.1");
    expect(calls).toEqual(["createMap 51.5,-0.1"]);
    expect(container.hasAttribute("hidden")).toBe(false);
  });

  test("leaves the container hidden while there is no pin", () => {
    const { calls, container } = setup("", "");
    expect(calls).toEqual([]);
    expect(container.hasAttribute("hidden")).toBe(true);
  });

  test("re-pins the existing map when the inputs change", () => {
    const { calls, setInput } = setup("51.5", "-0.1");
    setInput("lat", "52.0");
    expect(calls).toEqual([
      "createMap 51.5,-0.1",
      "refreshSize",
      "moveTo 52,-0.1",
    ]);
  });

  test("creates the map on the first valid pin typed in", () => {
    const { calls, container, setInput } = setup("", "");
    setInput("lat", "51.5");
    expect(calls).toEqual([]);
    setInput("lng", "-0.1");
    expect(calls).toEqual(["createMap 51.5,-0.1"]);
    expect(container.hasAttribute("hidden")).toBe(false);
  });

  test("hides the map again when a pin is cleared", () => {
    const { container, setInput } = setup("51.5", "-0.1");
    setInput("lat", "");
    expect(container.hasAttribute("hidden")).toBe(true);
  });

  test("does nothing on pages without the map container", () => {
    installDom('<input name="lat"><input name="lng">');
    const { calls, library } = fakeLibrary();
    expect(() => initLogisticsMap(library)).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("does nothing when the pin inputs are missing", () => {
    const window = installDom("<div data-logistics-map hidden></div>");
    const { calls, library } = fakeLibrary();
    initLogisticsMap(library);
    expect(calls).toEqual([]);
    expect(
      window.document
        .querySelector("[data-logistics-map]")!
        .hasAttribute("hidden"),
    ).toBe(true);
  });
});

describe("initLogisticsMapLoader", () => {
  test("injects the map bundle and stylesheet when the page has a map", () => {
    const window = installDom(
      '<script src="/admin.js?ts=99"></script><div data-logistics-map></div>',
    );
    initLogisticsMapLoader();
    const head = window.document.head;
    expect(head.querySelector("script")?.getAttribute("src")).toBe(
      "/logistics-map.js?ts=99",
    );
    expect(head.querySelector("link")?.getAttribute("href")).toBe(
      "/logistics-map.css?ts=99",
    );
    expect(head.querySelector("link")?.getAttribute("rel")).toBe("stylesheet");
  });

  test("loads nothing on pages without a map", () => {
    const window = installDom("<div></div>");
    initLogisticsMapLoader();
    expect(window.document.head.querySelector("script")).toBeNull();
    expect(window.document.head.querySelector("link")).toBeNull();
  });
});
