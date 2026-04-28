/**
 * Procedural rock/heavy-metal band-name and venue generator for sample data.
 *
 * Combines large pools of weird adjectives, nouns, person names, suffixes,
 * venue types, and festival words via a small set of grammatical patterns.
 * All randomness flows through a seeded PRNG (mulberry32) so the same seed
 * produces the same names across runs — handy for tests and stable demos.
 */

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
// Word pools
// ---------------------------------------------------------------------------

/** Weird, evocative adjectives suitable for metal/rock band names */
export const BAND_ADJECTIVES = [
  "Brutal",
  "Equine",
  "Mystic",
  "Screaming",
  "Savage",
  "Eternal",
  "Forbidden",
  "Cursed",
  "Crystal",
  "Velvet",
  "Iron",
  "Black",
  "Crimson",
  "Ghastly",
  "Howling",
  "Roaring",
  "Whispering",
  "Burning",
  "Frozen",
  "Molten",
  "Electric",
  "Toxic",
  "Radioactive",
  "Phantom",
  "Spectral",
  "Skeletal",
  "Demonic",
  "Angelic",
  "Holy",
  "Unholy",
  "Profane",
  "Sacred",
  "Vengeful",
  "Wretched",
  "Tragic",
  "Tortured",
  "Twisted",
  "Bleeding",
  "Pale",
  "Withered",
  "Reanimated",
  "Drunken",
  "Feral",
  "Rabid",
  "Mighty",
  "Tyrannical",
  "Imperial",
  "Royal",
  "Divine",
  "Apocalyptic",
  "Cosmic",
  "Lunar",
  "Solar",
  "Stellar",
  "Astral",
  "Voidborn",
  "Infernal",
  "Diabolical",
  "Sinister",
  "Cataclysmic",
  "Volcanic",
  "Glacial",
  "Granite",
  "Marbled",
  "Gilded",
  "Tarnished",
  "Mercurial",
  "Mongolian",
  "Jurassic",
  "Chrome",
  "Diesel",
  "Atomic",
  "Neon",
  "Plastic",
  "Wooden",
  "Rusted",
  "Festering",
  "Slithering",
  "Glowing",
  "Magnetic",
  "Thunderous",
  "Subterranean",
  "Hyperborean",
  "Perpetual",
  "Hooded",
  "Velour",
  "Magic",
  "Naked",
  "Hidden",
  "Drowning",
  "Choking",
  "Greasy",
  "Dusty",
  "Rotting",
  "Yelping",
  "Polite",
  "Ancient",
  "Vintage",
  "Final",
  "Last",
] as const;

/** Concrete and abstract nouns that work as band-name subjects */
export const BAND_NOUNS = [
  "Fox",
  "Garlic",
  "Handshake",
  "Hand",
  "Wolf",
  "Raven",
  "Crow",
  "Vulture",
  "Spider",
  "Scorpion",
  "Serpent",
  "Dragon",
  "Hydra",
  "Kraken",
  "Octopus",
  "Shark",
  "Whale",
  "Phoenix",
  "Griffin",
  "Behemoth",
  "Tomb",
  "Tower",
  "Crypt",
  "Cathedral",
  "Temple",
  "Throne",
  "Crown",
  "Skull",
  "Bone",
  "Blood",
  "Fang",
  "Claw",
  "Wing",
  "Eye",
  "Heart",
  "Spine",
  "Mind",
  "Soul",
  "Ghost",
  "Witch",
  "Wizard",
  "Warlock",
  "Necromancer",
  "Knight",
  "Crusader",
  "Marauder",
  "Berserker",
  "Viking",
  "Templar",
  "Reaper",
  "Executioner",
  "Hangman",
  "Butcher",
  "Doctor",
  "Surgeon",
  "Priest",
  "Prophet",
  "Oracle",
  "Pilgrim",
  "Wanderer",
  "Vagabond",
  "Mariner",
  "Pirate",
  "Monarch",
  "Tyrant",
  "Emperor",
  "Beast",
  "Hound",
  "Stallion",
  "Mongoose",
  "Otter",
  "Falcon",
  "Eagle",
  "Owl",
  "Bat",
  "Moth",
  "Beetle",
  "Toad",
  "Frog",
  "Newt",
  "Cobra",
  "Mantis",
  "Hornet",
  "Wasp",
  "Locust",
  "Cicada",
  "Salmon",
  "Pike",
  "Eel",
  "Squid",
  "Tree",
  "Forest",
  "Mountain",
  "River",
  "Ocean",
  "Storm",
  "Tempest",
  "Cyclone",
  "Avalanche",
  "Comet",
  "Meteor",
  "Nebula",
  "Galaxy",
  "Void",
  "Abyss",
  "Inferno",
  "Pit",
  "Cavern",
  "Dungeon",
  "Castle",
  "Fortress",
  "Citadel",
  "Bastion",
  "Hammer",
  "Axe",
  "Sword",
  "Dagger",
  "Mace",
  "Whip",
  "Chain",
  "Anvil",
  "Forge",
  "Cauldron",
  "Chalice",
  "Goblet",
  "Mirror",
  "Compass",
  "Lantern",
  "Candle",
  "Coffin",
  "Casket",
  "Sarcophagus",
  "Pyre",
  "Procession",
  "Gallery",
  "Pantheon",
  "Tree",
  "Rabbit",
  "Badger",
  "Goose",
  "Duck",
  "Pigeon",
  "Sandwich",
  "Onion",
  "Turnip",
  "Cabbage",
  "Pickle",
  "Trousers",
  "Moustache",
] as const;

/** First names used for "{Adjective} {Name} and Friends"-style patterns */
export const BAND_PERSON_NAMES = [
  "David",
  "Ozzy",
  "Lemmy",
  "Dio",
  "Axl",
  "Slash",
  "Iggy",
  "Bowie",
  "Bruce",
  "Eddie",
  "Glenn",
  "Henry",
  "Tommy",
  "Johnny",
  "Ronnie",
  "Vincent",
  "Alice",
  "Stevie",
  "Jimmy",
  "Roger",
  "Trevor",
  "Brian",
  "Geoff",
  "Maureen",
  "Pamela",
  "Cassandra",
  "Susan",
  "Beverly",
  "Gladys",
  "Doris",
  "Mildred",
  "Wilma",
  "Bernard",
  "Norman",
  "Reginald",
  "Cyril",
  "Mortimer",
  "Algernon",
  "Cornelius",
  "Bartholomew",
] as const;

/** Tail phrases that turn a noun phrase into a fully-realised band name */
export const BAND_SUFFIXES = [
  "of Doom",
  "of Mercy",
  "of Sorrow",
  "of the Damned",
  "of the Forsaken",
  "and Friends",
  "Reunited",
  "Unleashed",
  "Resurrected",
  "Returns",
  "Forever",
  "Reborn",
  "Triumphant",
  "Ascendant",
  "of the Apocalypse",
  "of the Void",
  "of the Storm",
  "of the Abyss",
  "of the North",
  "of Chaos",
  "of Madness",
  "of Eternity",
  "of the Crypt",
  "and the Disciples",
  "and the Acolytes",
  "and the Pilgrims",
  "and Sons",
  "and Daughters",
  "Experience",
  "Project",
  "Collective",
  "Brigade",
  "Brotherhood",
  "Sisterhood",
  "Cult",
  "Coven",
  "Convocation",
  "Conspiracy",
  "Manifesto",
  "Revival",
  "Live in Concert",
  "MMXXVI",
] as const;

/** Indoor venue archetypes — concrete buildings/rooms */
export const VENUE_TYPES = [
  "Arena",
  "Academy",
  "Stadium",
  "Auditorium",
  "Hall",
  "Theatre",
  "Coliseum",
  "Amphitheatre",
  "Pavilion",
  "Forum",
  "Dome",
  "Centre",
  "Roundhouse",
  "Tabernacle",
  "Sanctuary",
  "Crypt",
  "Vault",
  "Bunker",
  "Warehouse",
  "Factory",
  "Mill",
  "Foundry",
  "Quarry",
  "Depot",
  "Garage",
  "Lounge",
  "Club",
  "Den",
  "Pit",
  "Chamber",
  "Ballroom",
  "Workingmen's Club",
  "Social Club",
  "Working Men's Institute",
] as const;

/** Outdoor / event-style venue archetypes */
export const FESTIVAL_TYPES = [
  "Festival",
  "Fest",
  "Fair",
  "Carnival",
  "Convention",
  "Summit",
  "Showcase",
  "Massacre",
  "Slaughter",
  "Bash",
  "Jamboree",
  "Riot",
  "Reckoning",
  "Pilgrimage",
  "Procession",
  "Reunion",
  "Tour",
  "Crusade",
  "Onslaught",
  "Weekender",
] as const;

/** Sub-genres used inside gig-description templates */
export const GENRES = [
  "doom",
  "sludge",
  "prog",
  "hardcore",
  "glam",
  "thrash",
  "death-metal",
  "black-metal",
  "stoner-rock",
  "folk-metal",
  "industrial",
  "symphonic",
  "hair-metal",
  "gothic",
  "drone",
  "speed-metal",
  "power-metal",
  "psychobilly",
  "darkwave",
  "post-punk",
  "shoegaze",
  "grindcore",
  "blackened-jazz",
  "viking-metal",
  "pirate-metal",
  "doom-jazz",
  "djent",
  "crust-punk",
] as const;

/** Hyperbolic adjective phrases for sensory descriptions */
export const INTENSITIES = [
  "ear-splitting",
  "brain-melting",
  "head-splitting",
  "ground-shaking",
  "soul-crushing",
  "deafening",
  "earth-shattering",
  "skin-peeling",
  "bone-rattling",
  "chest-thumping",
  "thoroughly inadvisable",
  "barely-legal",
] as const;

/** Concrete things you'd see / smell / regret at a gig */
export const SHOW_ITEMS = [
  "denim",
  "leather",
  "mead",
  "regret",
  "glory",
  "smoke",
  "lasers",
  "dry ice",
  "bandanas",
  "studs",
  "shredding solos",
  "blast beats",
  "double kicks",
  "fog machines",
  "questionable lyrics",
  "obscure cover versions",
  "extended drum solos",
  "merch you'll regret on Monday",
  "improvised pyrotechnics",
  "spilled beer",
] as const;

/** Wildly out-of-place instruments for novelty descriptions */
export const ODD_INSTRUMENTS = [
  "theremin",
  "ukulele",
  "bagpipes",
  "hurdy-gurdy",
  "kazoo",
  "glockenspiel",
  "accordion",
  "harp",
  "sitar",
  "mandolin",
  "stylophone",
  "didgeridoo",
  "vacuum cleaner",
  "Casio keyboard",
] as const;

/** Improbable buildings to be "converted into" a venue */
export const WEIRD_VENUES = [
  "lift shaft",
  "granary",
  "bus depot",
  "brewery vat",
  "postal sorting office",
  "cattle market",
  "abandoned multi-storey",
  "decommissioned chapel",
  "1980s leisure centre",
  "shipping container",
  "village butcher's freezer",
  "art-deco cinema",
  "Victorian bathhouse",
] as const;

/** Spelled-out small numbers for descriptions */
export const NUMBER_WORDS = [
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "twelve",
] as const;

/** Adjectives that qualify a "tour" */
export const TOUR_ADJECTIVES = [
  "farewell",
  "reunion",
  "comeback",
  "retrospective",
  "anniversary",
  "definitely-the-last",
  "victory",
  "redemption",
  "vengeance",
] as const;

/** Collective nouns for "the band's reputation" */
export const BAND_DESCRIPTORS = [
  "pioneers",
  "warriors",
  "legends",
  "veterans",
  "prophets",
  "godfathers",
  "stalwarts",
  "diehards",
  "originators",
  "cult heroes",
] as const;

/** Themes for crossover/novelty acts */
export const CROSSOVERS = [
  "sea-shanty",
  "druid",
  "viking",
  "pirate",
  "robot",
  "ghost",
  "morris-dance",
  "bagpipe",
  "yodelling",
  "yacht-rock",
  "monster-truck",
  "sci-fi",
] as const;

/** Verbs for "the band ___ed the venue" */
export const NOISE_VERBS = [
  "invade",
  "descend on",
  "tear through",
  "assault",
  "demolish",
  "conquer",
  "devastate",
  "obliterate",
  "occupy",
  "set fire to",
] as const;

/** Audience-eligibility blurbs */
export const AGE_NOTES = [
  "all ages welcome",
  "18+ only",
  "14+ with parent",
  "family-friendly",
  "parental advisory in effect",
  "strictly grown-ups",
] as const;

/** Things that are absolutely not allowed at this gig */
export const PROHIBITIONS = [
  "stage diving onto the pizza",
  "phones above shoulder height",
  "vuvuzelas",
  "glitter cannons",
  "throwing pints",
  "uninvited cowbell",
  "amateur pyrotechnics",
  "crowdsurfing inflatables",
  "audience requests",
] as const;

/** Items of clothing that are notionally compulsory */
export const REQUIREMENTS = [
  "sequins",
  "leather",
  "denim",
  "mascara",
  "hairspray",
  "shoulder pads",
  "bullet belts",
  "tasselled jackets",
  "shredded jeans",
  "spandex",
  "corpse paint",
] as const;

/** Karaoke / dress-up prize categories */
export const PRIZES = [
  "biggest hair",
  "loudest scream",
  "best devil horns",
  "most convincing growl",
  "longest air-guitar solo",
  "deepest voice",
  "most denim worn at once",
  "most authentic mullet",
] as const;

/** Common gig start times */
export const TIMES = ["6", "7", "7:30", "8", "8:30", "9", "10"] as const;

// ---------------------------------------------------------------------------
// Pattern templates
// ---------------------------------------------------------------------------

/**
 * A pool name that can appear inside a `{slot}` placeholder in a template.
 * `renderTemplate` walks the template once and substitutes each slot for a
 * fresh pick from the corresponding word pool.
 */
const SLOT_POOLS: Record<string, readonly string[]> = {
  adj: BAND_ADJECTIVES,
  ageNote: AGE_NOTES,
  bandDescriptor: BAND_DESCRIPTORS,
  crossover: CROSSOVERS,
  festival: FESTIVAL_TYPES,
  genre: GENRES,
  intensity: INTENSITIES,
  noiseVerb: NOISE_VERBS,
  noun: BAND_NOUNS,
  number: NUMBER_WORDS,
  oddInstrument: ODD_INSTRUMENTS,
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

const DESCRIPTION_PATTERNS = [
  "An {intensity} night of {showItem}, {showItem}, and {showItem}",
  "Doors at {time}, support from {number} local bands, headliners on at {time}",
  "A {tourAdj} tour celebrating decades of riffs and regret",
  "{genre} {bandDescriptor} return for one {tourAdj} show",
  "All-day {genre} odyssey with {number} drum kits and at least one {oddInstrument}",
  "{genre} triple bill — bring earplugs and a clear conscience",
  "{genre}, {genre}, and one slightly out-of-tune {oddInstrument}",
  "{genre} warriors {noiseVerb} the venue for a night of {showItem} and {showItem}",
  "An unplugged evening reimagining the heaviest cuts on a single {oddInstrument}",
  "{genre} matinee, {ageNote}, no {prohibition}",
  "Power-ballad karaoke night, prizes for {prize}",
  "{genre} revival showcase — {requirement} compulsory, {requirement} optional",
  "{genre} collective performing inside a converted {weirdVenue}",
  "{crossover} crossover act makes its triumphant debut",
  "Symphonic {genre} night with the local orchestra and one very loud guitarist",
  "A surprise album launch — strict no-phones policy strictly enforced",
  "Tribute night running through the entire back catalogue, B-sides included",
  "The reunion no one asked for and absolutely everyone will attend",
  "{intensity} {genre} matinee — {ageNote}, no {prohibition}",
  "Three-band bill: {genre}, {genre}, and {genre} acts assembled for one night only",
  "{bandDescriptor} of {genre} {noiseVerb} the stage with {number} guitars",
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
