import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BAND_ADJECTIVES,
  BAND_NOUNS,
  BAND_PERSON_NAMES,
  BAND_SUFFIXES,
  createRand,
  DEFAULT_BAND_SEED,
  DEFAULT_DESCRIPTION_SEED,
  DEFAULT_VENUE_SEED,
  FESTIVAL_TYPES,
  generateBandNames,
  generateDescriptions,
  generateVenueNames,
  pickFrom,
  VENUE_TYPES,
} from "#shared/band-name-generator.ts";

describe("createRand", () => {
  test("produces the expected Mulberry32 sequence for a fixed seed", () => {
    const rand = createRand(0x12345678);

    expect([rand(), rand(), rand(), rand()]).toEqual([
      0.10615200875326991, 0.941276284167543, 0.9398706152569503,
      0.2338848018553108,
    ]);
  });

  test("pickFrom maps seeded random values to stable array indexes", () => {
    const rand = createRand(0x12345678);
    const pool = ["alpha", "beta", "gamma", "delta"];

    expect([
      pickFrom(rand, pool),
      pickFrom(rand, pool),
      pickFrom(rand, pool),
      pickFrom(rand, pool),
    ]).toEqual(["alpha", "delta", "delta", "alpha"]);
  });
});

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

describe("generateDescriptions", () => {
  test("returns exactly `count` descriptions", () => {
    expect(generateDescriptions(40, DEFAULT_DESCRIPTION_SEED).length).toBe(40);
  });

  test("is deterministic for the same seed", () => {
    expect(generateDescriptions(20, 42)).toEqual(generateDescriptions(20, 42));
  });

  test("differs between seeds", () => {
    expect(generateDescriptions(10, 1)).not.toEqual(
      generateDescriptions(10, 2),
    );
  });

  test("every description starts with a capital letter", () => {
    for (const d of generateDescriptions(40, DEFAULT_DESCRIPTION_SEED)) {
      expect(d.length).toBeGreaterThan(0);
      expect(d[0]).toBe(d[0]!.toUpperCase());
    }
  });

  test("articles agree with the following word", () => {
    for (const d of generateDescriptions(80, DEFAULT_DESCRIPTION_SEED)) {
      // No "An <consonant>" or "A <vowel>" left after fixArticles runs.
      expect(d).not.toMatch(/\bAn [^aeiouAEIOU]/);
      expect(d).not.toMatch(/\bA [aeiouAEIOU]/);
    }
  });
});
