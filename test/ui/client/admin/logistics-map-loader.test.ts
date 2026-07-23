/**
 * The logistics-map loader: on pages that render a map container it injects
 * the map bundle and stylesheet (cache-busted to match the admin bundle),
 * and stays inert everywhere else.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initLogisticsMapLoader } from "#src/ui/client/admin/logistics-map-loader.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();

afterEach(cleanup);

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
});
