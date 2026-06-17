import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { appleMapsUrl, googleMapsUrl, mapLinks } from "#shared/maps.ts";
import { MapsLinks } from "#templates/components/maps-links.tsx";

test("googleMapsUrl encodes the query", () => {
  expect(googleMapsUrl("1 High St, Town")).toBe(
    "https://www.google.com/maps/search/?api=1&query=1%20High%20St%2C%20Town",
  );
});

test("appleMapsUrl encodes the query", () => {
  expect(appleMapsUrl("1 High St, Town")).toBe(
    "https://maps.apple.com/?q=1%20High%20St%2C%20Town",
  );
});

test("mapLinks returns Google then Apple for a non-blank query", () => {
  const links = mapLinks("Somewhere");
  expect(links.map((l) => l.provider)).toEqual(["Google", "Apple"]);
});

test("mapLinks returns nothing for a blank/whitespace query", () => {
  expect(mapLinks("")).toEqual([]);
  expect(mapLinks("   ")).toEqual([]);
});

test("MapsLinks renders both provider links for an address", () => {
  const html = String(MapsLinks({ query: "1 High St" }));
  expect(html).toContain("maps:");
  // Apple URL has no & to escape; assert it verbatim.
  expect(html).toContain(`href="${appleMapsUrl("1 High St")}"`);
  // The Google URL's & is HTML-escaped to &amp; in the rendered href.
  expect(html).toContain(
    'href="https://www.google.com/maps/search/?api=1&amp;query=1%20High%20St"',
  );
  expect(html).toContain(">Google<");
  expect(html).toContain(">Apple<");
});

test("MapsLinks renders nothing for a blank address", () => {
  expect(MapsLinks({ query: "" })).toBeNull();
});
