/**
 * Procedural rock/heavy-metal band-name, venue, and gig-description
 * generator for sample data.
 *
 * Word pools live as one-file-per-list under `band-name-generator/`. This
 * module composes them with a small set of slot-heavy templates and a
 * seeded PRNG (mulberry32) so every output is deterministic given a seed
 * yet the variety is enormous.
 */

import { BAND_ADJECTIVES } from "#lib/band-name-generator/adjectives.ts";
import { AGE_NOTES } from "#lib/band-name-generator/age-notes.ts";
import { AUDIENCE_OUTCOMES } from "#lib/band-name-generator/audience-outcomes.ts";
import { BAND_DESCRIPTORS } from "#lib/band-name-generator/band-descriptors.ts";
import { BAND_VERBS } from "#lib/band-name-generator/band-verbs.ts";
import { BUILDING_STATES } from "#lib/band-name-generator/building-states.ts";
import { CONNECTORS } from "#lib/band-name-generator/connectors.ts";
import { CROSSOVERS } from "#lib/band-name-generator/crossovers.ts";
import { EVENT_TYPES } from "#lib/band-name-generator/event-types.ts";
import { FESTIVAL_TYPES } from "#lib/band-name-generator/festival-types.ts";
import { GENRES } from "#lib/band-name-generator/genres.ts";
import { INTENSITIES } from "#lib/band-name-generator/intensities.ts";
import { NOISE_VERBS } from "#lib/band-name-generator/noise-verbs.ts";
import { BAND_NOUNS } from "#lib/band-name-generator/nouns.ts";
import { NUMBER_WORDS } from "#lib/band-name-generator/number-words.ts";
import { ODD_INSTRUMENTS } from "#lib/band-name-generator/odd-instruments.ts";
import { BAND_PERSON_NAMES } from "#lib/band-name-generator/person-names.ts";
import { PRIZES } from "#lib/band-name-generator/prizes.ts";
import { PROHIBITIONS } from "#lib/band-name-generator/prohibitions.ts";
import { REQUIREMENTS } from "#lib/band-name-generator/requirements.ts";
import { SHOW_ITEMS } from "#lib/band-name-generator/show-items.ts";
import { BAND_SUFFIXES } from "#lib/band-name-generator/suffixes.ts";
import { TIMES } from "#lib/band-name-generator/times.ts";
import { TOUR_ADJECTIVES } from "#lib/band-name-generator/tour-adjectives.ts";
import { VENUE_TYPES } from "#lib/band-name-generator/venue-types.ts";
import { WEIRD_VENUES } from "#lib/band-name-generator/weird-venues.ts";

// Re-export every pool so existing call sites and tests can keep using
// `import { BAND_ADJECTIVES } from "#lib/band-name-generator.ts"`.
export {
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
  EVENT_TYPES,
  FESTIVAL_TYPES,
  GENRES,
  INTENSITIES,
  NOISE_VERBS,
  NUMBER_WORDS,
  ODD_INSTRUMENTS,
  PRIZES,
  PROHIBITIONS,
  REQUIREMENTS,
  SHOW_ITEMS,
  TIMES,
  TOUR_ADJECTIVES,
  VENUE_TYPES,
  WEIRD_VENUES,
};

/** A pseudo-random function returning a value in [0, 1) */
export type Rand = () => number;

/**
 * Mulberry32: tiny seeded PRNG with good distribution for this use case.
 * Returns a function that yields a new float in [0, 1) on each call.
 */
export const createRand = (seed: number): Rand => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Pick a random element from a non-empty readonly array using `rand` */
export const pickFrom = <T>(rand: Rand, arr: readonly T[]): T =>
  arr[Math.floor(rand() * arr.length)]!;

// ---------------------------------------------------------------------------
// Pattern templates
// ---------------------------------------------------------------------------

/**
 * Lookup table mapping every `{slot}` placeholder to its word pool.
 * `renderTemplate` walks each template once and substitutes each slot
 * for a fresh pick from the corresponding pool.
 */
const SLOT_POOLS: Record<string, readonly string[]> = {
  adj: BAND_ADJECTIVES,
  ageNote: AGE_NOTES,
  bandDescriptor: BAND_DESCRIPTORS,
  bandVerb: BAND_VERBS,
  buildingState: BUILDING_STATES,
  connector: CONNECTORS,
  crossover: CROSSOVERS,
  eventType: EVENT_TYPES,
  festival: FESTIVAL_TYPES,
  genre: GENRES,
  intensity: INTENSITIES,
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

/** Reconcile `a`/`an` with the actual word that ended up in the slot */
const fixArticles = (s: string): string =>
  s
    .replace(/\bAn ([^aeiouAEIOU])/g, "A $1")
    .replace(/\bA ([aeiouAEIOU])/g, "An $1");

/**
 * Replace each `{slot}` in `template` with a random pick from the matching
 * pool, then capitalise the first character and tidy up `a`/`an` so patterns
 * that begin with a lowercase pool entry still read as a proper sentence.
 */
const renderTemplate = (template: string, rand: Rand): string => {
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) =>
    pickFrom(rand, SLOT_POOLS[key]!),
  );
  const articled = fixArticles(filled);
  return articled.charAt(0).toUpperCase() + articled.slice(1);
};

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
] as const;

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
] as const;

// Description patterns lean heavily on slots so the connective tissue is
// minimal — most words come from the pools and uniqueness is very high.
const DESCRIPTION_PATTERNS = [
  "{intensity} {eventType} of {showItem}, {showItem}, and {showItem}",
  "{intensity} {genre} {eventType} — {ageNote}, no {prohibition}",
  "{tourAdj} {eventType} {connector} {genre} {bandDescriptor}",
  "{genre} {bandDescriptor} {noiseVerb} the {venue}",
  "{genre} {eventType} {connector} {number} {oddInstrument}",
  "{number} bands, {number} {oddInstrument}s, one {buildingState} {weirdVenue}",
  "{bandDescriptor} of {genre} {noiseVerb} the {venue} on a {eventType} of {showItem}",
  "{intensity} {eventType} of {genre}, {genre}, and {showItem}",
  "{genre} {eventType}, {ageNote}, no {prohibition}",
  "{crossover} {genre} {eventType} {connector} {oddInstrument}",
  "A {buildingState} {weirdVenue} hosts {genre} {bandDescriptor}",
  "{genre} {eventType} — {requirement} compulsory, {requirement} optional",
  "{genre} karaoke {eventType}, prizes for {prize}",
  "{tourAdj} tour {connector} {outcome} and {outcome}",
  "Doors at {time}, {genre} on at {time}, {outcome} by midnight",
  "{genre} collective inside a {buildingState} {weirdVenue}",
  "{bandDescriptor} {bandVerb} for one {tourAdj} {eventType}",
  "{intensity} {genre} {eventType} {connector} {oddInstrument} solos",
  "{genre} {bandDescriptor} {bandVerb} from the {weirdVenue}",
  "{intensity} {showItem}, {intensity} {showItem}, one {oddInstrument}",
  "{crossover} crossover {connector} {oddInstrument} and {showItem}",
  "{tourAdj} {eventType} ending in {outcome}",
  "{intensity} {genre} {connector} {requirement} and {requirement}",
  "{number} {genre} acts {connector} {number} {oddInstrument}",
  "{bandDescriptor} of {genre} return for one {tourAdj} {eventType}",
] as const;

/** Generate a single band name using the supplied PRNG */
const generateBandName = (rand: Rand): string =>
  renderTemplate(pickFrom(rand, BAND_PATTERNS), rand);

/** Generate a single venue / location name using the supplied PRNG */
const generateVenueName = (rand: Rand): string =>
  renderTemplate(pickFrom(rand, VENUE_PATTERNS), rand);

/** Generate a single gig-description blurb using the supplied PRNG */
const generateDescription = (rand: Rand): string =>
  renderTemplate(pickFrom(rand, DESCRIPTION_PATTERNS), rand);

// ---------------------------------------------------------------------------
// Bulk generation
// ---------------------------------------------------------------------------

/** Seed used to build the demo arrays exposed from `lib/demo.ts` */
export const DEFAULT_BAND_SEED = 0xb1eed1ed;

/** Seed used to build the venue arrays exposed from `lib/demo.ts` */
export const DEFAULT_VENUE_SEED = 0x57a6ed00;

/** Seed used to build the description arrays exposed from `lib/demo.ts` */
export const DEFAULT_DESCRIPTION_SEED = 0xde5c0f6c;

const seededList =
  (gen: (rand: Rand) => string) =>
  (count: number, seed: number): string[] => {
    const rand = createRand(seed);
    return Array.from({ length: count }, () => gen(rand));
  };

/** Generate `count` band names, deterministic given `seed` */
export const generateBandNames = seededList(generateBandName);

/** Generate `count` venue names, deterministic given `seed` */
export const generateVenueNames = seededList(generateVenueName);

/** Generate `count` gig-description blurbs, deterministic given `seed` */
export const generateDescriptions = seededList(generateDescription);
