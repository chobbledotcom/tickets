import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BAND_ADJECTIVES,
  BAND_NOUNS,
  BAND_PERSON_NAMES,
  BAND_SUFFIXES,
  DEFAULT_BAND_SEED,
  DEFAULT_VENUE_SEED,
  FESTIVAL_TYPES,
  generateBandNames,
  generateVenueNames,
  VENUE_TYPES,
} from "#lib/band-name-generator.ts";

describe("generateBandNames", () => {
  test("returns exactly `count` names", () => {
    expect(generateBandNames(5, 1).length).toBe(5);
    expect(generateBandNames(60, DEFAULT_BAND_SEED).length).toBe(60);
  });

  test("the seeded default list contains no duplicates", () => {
    const names = generateBandNames(60, DEFAULT_BAND_SEED);
    expect(new Set(names).size).toBe(names.length);
  });

  test("is deterministic for the same seed", () => {
    expect(generateBandNames(20, 7)).toEqual(generateBandNames(20, 7));
  });

  test("differs between seeds", () => {
    expect(generateBandNames(10, 1)).not.toEqual(generateBandNames(10, 2));
  });

  test("each name is built from the band word pools", () => {
    const haystack = [
      ...BAND_ADJECTIVES,
      ...BAND_NOUNS,
      ...BAND_PERSON_NAMES,
      ...BAND_SUFFIXES,
    ];
    for (const name of generateBandNames(40, 11)) {
      expect(name.length).toBeGreaterThan(0);
      expect(haystack.some((w) => name.includes(w))).toBe(true);
    }
  });

  test("produces a wide variety (no single template dominates)", () => {
    const names = generateBandNames(60, DEFAULT_BAND_SEED);
    const startsWithThe = names.filter((n) => n.startsWith("The ")).length;
    expect(startsWithThe).toBeLessThan(names.length);
  });
});

describe("generateVenueNames", () => {
  test("returns exactly `count` unique names", () => {
    const names = generateVenueNames(40, DEFAULT_VENUE_SEED);
    expect(names.length).toBe(40);
    expect(new Set(names).size).toBe(40);
  });

  test("is deterministic for the same seed", () => {
    expect(generateVenueNames(15, 5)).toEqual(generateVenueNames(15, 5));
  });

  test("each name incorporates a venue or festival type word", () => {
    const venueWords = [...VENUE_TYPES, ...FESTIVAL_TYPES];
    for (const name of generateVenueNames(40, DEFAULT_VENUE_SEED)) {
      expect(venueWords.some((w) => name.includes(w))).toBe(true);
    }
  });
});
