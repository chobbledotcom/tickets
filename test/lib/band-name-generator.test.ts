import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  AGE_NOTES,
  AUDIENCE_OUTCOMES,
  BAND_ADJECTIVES,
  BAND_DESCRIPTORS,
  BAND_NOUNS,
  BAND_PERSON_NAMES,
  BAND_SUFFIXES,
  BAND_VERBS,
  BUILDING_STATES,
  CONNECTORS,
  CROSSOVERS,
  createRand,
  DEFAULT_BAND_SEED,
  DEFAULT_DESCRIPTION_SEED,
  DEFAULT_VENUE_SEED,
  FESTIVAL_TYPES,
  GENRES,
  generateBandNames,
  generateDescriptions,
  generateVenueNames,
  INTENSITIES,
  LISTING_TYPES,
  NOISE_VERBS,
  NUMBER_WORDS,
  ODD_INSTRUMENTS,
  PRIZES,
  PROHIBITIONS,
  pickFrom,
  REQUIREMENTS,
  SHOW_ITEMS,
  TIMES,
  TOUR_ADJECTIVES,
  VENUE_TYPES,
  WEIRD_VENUES,
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

// Pinned outputs for the default seeds. These double as a regression check on
// the seed constants themselves (a changed seed renders different text) and
// on renderTemplate's capitalisation (a botched charAt/slice index would
// produce different text at the same position).
describe("golden outputs for the default seeds", () => {
  test("first band name", () => {
    expect(generateBandNames(1, DEFAULT_BAND_SEED)[0]).toBe(
      "Insatiable Rabid Hydra",
    );
  });

  test("first venue name", () => {
    expect(generateVenueNames(1, DEFAULT_VENUE_SEED)[0]).toBe(
      "The Boiler Room of Caboose",
    );
  });

  test("first description (capitalises a lowercase pool word)", () => {
    expect(generateDescriptions(1, DEFAULT_DESCRIPTION_SEED)[0]).toBe(
      "Approximately-original-lineup reckoning supported by blackgaze eternal underdogs",
    );
  });

  test("fixes 'A' to 'An' before a vowel-starting building state", () => {
    expect(generateDescriptions(120, DEFAULT_DESCRIPTION_SEED)[119]).toBe(
      "An informally-occupied former HMV hosts emo-violence warriors",
    );
  });

  test("leaves 'A' as-is before a consonant-starting building state", () => {
    expect(generateDescriptions(24, DEFAULT_DESCRIPTION_SEED)[23]).toBe(
      "A derelict padlocked snooker hall hosts crust-punk diehards",
    );
  });
});

// Every pattern template, copied from band-name-generator.ts (the arrays
// themselves aren't exported — only reachable through the generate*
// functions). Mutating any template's literal text must make it stop
// matching its regex here, for every sample that used it.
const BAND_PATTERNS = [
  "The {adj} {noun}",
  "The {adj} {noun} {suffix}",
  "{adj} {noun}",
  "{adj} {noun} {suffix}",
  "{noun}'s {adj} {noun}",
  "{adj} {person} {suffix}",
  "{person} {suffix}",
  "{adj} {adj} {noun}",
  "The {adj} {adj} {noun}",
  "A {adj} {noun}",
  "{noun} of {noun}",
  "The {noun} of {noun}",
  "{noun} {suffix}",
  "{person} and the {adj} {noun}",
];

const VENUE_PATTERNS = [
  "The {noun} {venue}",
  "The {adj} {noun} {venue}",
  "{noun} {venue}",
  "{adj} {noun} {festival}",
  "The {noun} {festival}",
  "{noun}'s {venue}",
  "The {venue} of {noun}",
  "The {adj} {venue}",
  "{noun} {festival}",
  "{person}'s {venue}",
];

const DESCRIPTION_PATTERNS = [
  "{intensity} {listingType} of {showItem}, {showItem}, and {showItem}",
  "{intensity} {genre} {listingType} — {ageNote}, no {prohibition}",
  "{tourAdj} {listingType} {connector} {genre} {bandDescriptor}",
  "{genre} {bandDescriptor} {noiseVerb} the {venue}",
  "{genre} {listingType} {connector} {number} {oddInstrument}",
  "{number} bands, {number} {oddInstrument}s, one {buildingState} {weirdVenue}",
  "{bandDescriptor} of {genre} {noiseVerb} the {venue} on a {listingType} of {showItem}",
  "{intensity} {listingType} of {genre}, {genre}, and {showItem}",
  "{genre} {listingType}, {ageNote}, no {prohibition}",
  "{crossover} {genre} {listingType} {connector} {oddInstrument}",
  "A {buildingState} {weirdVenue} hosts {genre} {bandDescriptor}",
  "{genre} {listingType} — {requirement} compulsory, {requirement} optional",
  "{genre} karaoke {listingType}, prizes for {prize}",
  "{tourAdj} tour {connector} {outcome} and {outcome}",
  "Doors at {time}, {genre} on at {time}, {outcome} by midnight",
  "{genre} collective inside a {buildingState} {weirdVenue}",
  "{bandDescriptor} {bandVerb} for one {tourAdj} {listingType}",
  "{intensity} {genre} {listingType} {connector} {oddInstrument} solos",
  "{genre} {bandDescriptor} {bandVerb} from the {weirdVenue}",
  "{intensity} {showItem}, {intensity} {showItem}, one {oddInstrument}",
  "{crossover} crossover {connector} {oddInstrument} and {showItem}",
  "{tourAdj} {listingType} ending in {outcome}",
  "{intensity} {genre} {connector} {requirement} and {requirement}",
  "{number} {genre} acts {connector} {number} {oddInstrument}",
  "{bandDescriptor} of {genre} return for one {tourAdj} {listingType}",
];

// Mirrors the private SLOT_POOLS map in band-name-generator.ts, so each
// slot's regex only accepts its actual pool words — not any string. A loose
// `.+` per slot would let a mutated template's corrupted tail get absorbed
// by some other (also loose) pattern's slot, hiding the mutation.
const SLOT_POOLS: Record<string, readonly string[]> = {
  adj: BAND_ADJECTIVES,
  ageNote: AGE_NOTES,
  bandDescriptor: BAND_DESCRIPTORS,
  bandVerb: BAND_VERBS,
  buildingState: BUILDING_STATES,
  connector: CONNECTORS,
  crossover: CROSSOVERS,
  festival: FESTIVAL_TYPES,
  genre: GENRES,
  intensity: INTENSITIES,
  listingType: LISTING_TYPES,
  noiseVerb: NOISE_VERBS,
  noun: BAND_NOUNS,
  number: NUMBER_WORDS,
  oddInstrument: ODD_INSTRUMENTS,
  outcome: AUDIENCE_OUTCOMES,
  person: BAND_PERSON_NAMES,
  prize: PRIZES,
  prohibition: PROHIBITIONS,
  requirement: REQUIREMENTS,
  showItem: SHOW_ITEMS,
  suffix: BAND_SUFFIXES,
  time: TIMES,
  tourAdj: TOUR_ADJECTIVES,
  venue: VENUE_TYPES,
  weirdVenue: WEIRD_VENUES,
};

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Alternation of a slot's pool words. The first slot in a template also
 * accepts each word with its first letter capitalised, since renderTemplate
 * capitalises the whole string's first character. */
const slotAlternation = (key: string, isFirstSlot: boolean): string => {
  const words = SLOT_POOLS[key]!;
  const variants = isFirstSlot
    ? words.flatMap((w) => [w, w.charAt(0).toUpperCase() + w.slice(1)])
    : words;
  return `(?:${[...new Set(variants)].map(escapeRegex).join("|")})`;
};

/** Build a regex matching a rendered template: literal text stays literal,
 * `{slot}` becomes an alternation of that slot's real pool words, and a
 * leading "A " tolerates the "An" correction (the only place any template
 * needs it — see fixArticles). */
const templateRegex = (template: string): RegExp => {
  const segments = template.split(/(\{\w+\})/g);
  const firstSlotIndex = segments.findIndex((part) => /^\{\w+\}$/.test(part));
  const body = segments
    .map((part, index) => {
      const slotMatch = /^\{(\w+)\}$/.exec(part);
      return slotMatch
        ? slotAlternation(slotMatch[1]!, index === firstSlotIndex)
        : escapeRegex(part);
    })
    .join("")
    .replace(/^A /, "(?:A|An) ");
  return new RegExp(`^${body}$`);
};

/** Every sample matches one known pattern, and every pattern matches at
 * least one sample — so mutating any pattern's literal text is caught
 * whether the mutant renders as blank output or a corrupted string. */
const expectFullPatternCoverage = (
  patterns: readonly string[],
  samples: readonly string[],
): void => {
  const regexes = patterns.map(templateRegex);
  for (const sample of samples) {
    expect(regexes.some((re) => re.test(sample))).toBe(true);
  }
  for (const re of regexes) {
    expect(samples.some((s) => re.test(s))).toBe(true);
  }
};

describe("pattern template coverage", () => {
  test("every band pattern is used, and every band name matches a known pattern", () => {
    expectFullPatternCoverage(
      BAND_PATTERNS,
      generateBandNames(120, DEFAULT_BAND_SEED),
    );
  });

  test("every venue pattern is used, and every venue name matches a known pattern", () => {
    expectFullPatternCoverage(
      VENUE_PATTERNS,
      generateVenueNames(150, DEFAULT_VENUE_SEED),
    );
  });

  test("every description pattern is used, and every description matches a known pattern", () => {
    expectFullPatternCoverage(
      DESCRIPTION_PATTERNS,
      generateDescriptions(250, DEFAULT_DESCRIPTION_SEED),
    );
  });
});
