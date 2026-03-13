/**
 * Demo mode - replaces user-entered text with sample data to prevent PII storage.
 * Enable by setting DEMO_MODE=true environment variable.
 */

import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";
import type { FieldValues } from "#lib/forms.tsx";
import type { NamedResource } from "#lib/rest/resource.ts";

// ---------------------------------------------------------------------------
// Demo mode flag
// ---------------------------------------------------------------------------

const [getDemoMode, setDemoMode] = lazyRef(
  () => getEnv("DEMO_MODE") === "true",
);

/** Check if demo mode is enabled */
export const isDemoMode = (): boolean => getDemoMode();

/** Reset cached demo mode value (for testing and cache invalidation) */
export const resetDemoMode = (): void => setDemoMode(null);

// ---------------------------------------------------------------------------
// Sample data arrays
// ---------------------------------------------------------------------------

/** Demo attendee names (full names for demo mode overrides) */
export const DEMO_NAMES = [
  "Alice Johnson",
  "Bob Smith",
  "Carol Williams",
  "Dave Brown",
  "Eve Davis",
  "Frank Miller",
  "Grace Wilson",
  "Henry Moore",
  "Ivy Taylor",
  "Jack Anderson",
  "Keiko Tanaka",
  "Liam O'Brien",
  "Maria Garcia",
  "Nadia Petrova",
  "Omar Hassan",
  "Priya Sharma",
  "Quincy Adams",
  "Rosa Hernandez",
  "Sven Lindqvist",
  "Tomoko Sato",
  "Uche Okafor",
  "Valentina Rossi",
  "Wei Zhang",
  "Xena Papadopoulos",
  "Yusuf Demir",
  "Zara Mbeki",
  "Aisling Murphy",
  "Bjorn Eriksson",
  "Chiara Bianchi",
  "Dmitri Volkov",
  "Elena Vasquez",
  "Fatima Al-Rashid",
  "George Kamau",
  "Hana Yoshida",
  "Ibrahim Diallo",
  "Jasmine Patel",
  "Kofi Mensah",
  "Leila Khoury",
  "Magnus Andersen",
  "Nkechi Eze",
  "Olga Novak",
  "Pablo Reyes",
  "Ravi Krishnan",
  "Sakura Watanabe",
  "Tariq Benmoussa",
  "Uma Devi",
  "Viktor Szabo",
  "Wanda Kowalski",
  "Yuki Nakamura",
  "Amara Osei",
] as const;

/** Demo first names for seed data (combined with surnames for more variety) */
export const DEMO_FIRST_NAMES = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Henry",
  "Ivy",
  "Jack",
  "Keiko",
  "Liam",
  "Maria",
  "Nadia",
  "Omar",
  "Priya",
  "Quincy",
  "Rosa",
  "Sven",
  "Tomoko",
  "Uche",
  "Valentina",
  "Wei",
  "Xena",
  "Yusuf",
  "Zara",
  "Aisling",
  "Bjorn",
  "Chiara",
  "Dmitri",
  "Elena",
  "Fatima",
  "George",
  "Hana",
  "Ibrahim",
  "Jasmine",
  "Kofi",
  "Leila",
  "Magnus",
  "Nkechi",
  "Olga",
  "Pablo",
  "Ravi",
  "Sakura",
  "Tariq",
  "Uma",
  "Viktor",
  "Wanda",
  "Yuki",
  "Amara",
  "Aiden",
  "Bianca",
  "Callum",
  "Daphne",
  "Emeka",
  "Fiona",
  "Gustavo",
  "Haruki",
  "Ingrid",
  "Javier",
  "Keira",
  "Lorenzo",
  "Mina",
  "Niall",
  "Oona",
  "Petra",
  "Rafael",
  "Sienna",
  "Theo",
  "Ursula",
  "Vijay",
  "Wendy",
  "Xiomara",
  "Yolanda",
  "Zane",
  "Aoife",
  "Benoit",
  "Celine",
  "Declan",
  "Esme",
  "Felix",
  "Gemma",
  "Hugo",
  "Isla",
  "Jules",
  "Khadija",
  "Lucian",
  "Maeve",
  "Nico",
  "Orla",
  "Piotr",
  "Quinn",
  "Rosario",
  "Saoirse",
  "Tomas",
] as const;

/** Demo surnames for seed data (combined with first names for more variety) */
export const DEMO_SURNAMES = [
  "Johnson",
  "Smith",
  "Williams",
  "Brown",
  "Davis",
  "Miller",
  "Wilson",
  "Moore",
  "Taylor",
  "Anderson",
  "Tanaka",
  "O'Brien",
  "Garcia",
  "Petrova",
  "Hassan",
  "Sharma",
  "Adams",
  "Hernandez",
  "Lindqvist",
  "Sato",
  "Okafor",
  "Rossi",
  "Zhang",
  "Papadopoulos",
  "Demir",
  "Mbeki",
  "Murphy",
  "Eriksson",
  "Bianchi",
  "Volkov",
  "Vasquez",
  "Al-Rashid",
  "Kamau",
  "Yoshida",
  "Diallo",
  "Patel",
  "Mensah",
  "Khoury",
  "Andersen",
  "Eze",
  "Novak",
  "Reyes",
  "Krishnan",
  "Watanabe",
  "Benmoussa",
  "Devi",
  "Szabo",
  "Kowalski",
  "Nakamura",
  "Osei",
  "Chen",
  "Fitzgerald",
  "Johansson",
  "Kim",
  "Larsson",
  "Moreau",
  "Nguyen",
  "O'Sullivan",
  "Park",
  "Russo",
  "Singh",
  "Torres",
  "Virtanen",
  "Weber",
  "Yamamoto",
  "Zimmerman",
  "Bergstrom",
  "Costa",
  "Dubois",
  "Fischer",
  "Gonzalez",
  "Horvat",
  "Ivanova",
  "Jensen",
  "Kapoor",
  "Li",
  "Martinez",
  "Nielsen",
  "Oduya",
  "Pereira",
  "Ramirez",
  "Svensson",
  "Takahashi",
  "Ueda",
  "Varga",
  "Walsh",
  "Xu",
  "Yilmaz",
] as const;

/** Demo email addresses */
export const DEMO_EMAILS = [
  "alice@example.com",
  "bob@example.com",
  "carol@example.com",
  "dave@example.com",
  "eve@example.com",
  "frank@example.com",
  "grace@example.com",
  "henry@example.com",
  "ivy@example.com",
  "jack@example.com",
  "keiko@example.com",
  "liam@example.com",
  "maria@example.com",
  "nadia@example.com",
  "omar@example.com",
  "priya@example.com",
  "quincy@example.com",
  "rosa@example.com",
  "sven@example.com",
  "tomoko@example.com",
  "uche@example.com",
  "valentina@example.com",
  "wei@example.com",
  "xena@example.com",
  "yusuf@example.com",
  "zara@example.com",
  "aisling@example.com",
  "bjorn@example.com",
  "chiara@example.com",
  "dmitri@example.com",
  "elena@example.com",
  "fatima@example.com",
  "george@example.com",
  "hana@example.com",
  "ibrahim@example.com",
  "jasmine@example.com",
  "kofi@example.com",
  "leila@example.com",
  "magnus@example.com",
  "nkechi@example.com",
  "olga@example.com",
  "pablo@example.com",
  "ravi@example.com",
  "sakura@example.com",
  "tariq@example.com",
  "uma@example.com",
  "viktor@example.com",
  "wanda@example.com",
  "yuki@example.com",
  "amara@example.com",
] as const;

/** Demo phone numbers (UK format) */
export const DEMO_PHONES = [
  "+44 7700 900001",
  "+44 7700 900002",
  "+44 7700 900003",
  "+44 7700 900004",
  "+44 7700 900005",
  "+44 7700 900006",
  "+44 7700 900007",
  "+44 7700 900008",
  "+44 7700 900009",
  "+44 7700 900010",
  "+44 7700 900011",
  "+44 7700 900012",
  "+44 7700 900013",
  "+44 7700 900014",
  "+44 7700 900015",
  "+44 7700 900016",
  "+44 7700 900017",
  "+44 7700 900018",
  "+44 7700 900019",
  "+44 7700 900020",
  "+44 7700 900021",
  "+44 7700 900022",
  "+44 7700 900023",
  "+44 7700 900024",
  "+44 7700 900025",
  "+44 7700 900026",
  "+44 7700 900027",
  "+44 7700 900028",
  "+44 7700 900029",
  "+44 7700 900030",
] as const;

/** Demo addresses */
export const DEMO_ADDRESSES = [
  "1 High Street, London, SW1A 1AA",
  "2 Main Road, Manchester, M1 1AA",
  "3 Church Lane, Bristol, BS1 1AA",
  "4 Park Avenue, Leeds, LS1 1AA",
  "5 Station Road, Birmingham, B1 1AA",
  "6 Mill Lane, Edinburgh, EH1 1AA",
  "7 Victoria Road, Cardiff, CF1 1AA",
  "8 Green Lane, Oxford, OX1 1AA",
  "9 King Street, Cambridge, CB1 1AA",
  "10 Queen's Road, Bath, BA1 1AA",
  "11 Riverside Drive, York, YO1 1AA",
  "12 Castle Street, Norwich, NR1 1AA",
  "13 Elm Close, Exeter, EX1 1AA",
  "14 Meadow Way, Canterbury, CT1 1AA",
  "15 Harbour View, Brighton, BN1 1AA",
] as const;

/** Demo special instructions */
export const DEMO_SPECIAL_INSTRUCTIONS = [
  "No special requirements",
  "Wheelchair access needed",
  "Vegetarian meal please",
  "Requires parking space",
  "Bringing a guide dog",
  "Gluten-free diet",
  "Hearing loop required",
  "Arriving late, please save seat",
  "Nut allergy - please advise catering",
  "Bringing two children under 5",
  "Need a seat near the exit",
  "Vegan meal please",
  "Lactose intolerant",
  "BSL interpreter needed",
  "Bringing own mobility scooter",
] as const;

/** Demo event names */
export const DEMO_EVENT_NAMES = [
  "Village Quiz Night",
  "Summer Fete",
  "Charity Fun Run",
  "Christmas Market",
  "Spring Concert",
  "Harvest Festival",
  "Bonfire Night",
  "Easter Egg Hunt",
  "Open Mic Night",
  "Barn Dance",
  "Bake-Off Competition",
  "Community Litter Pick",
  "Seniors Tea Party",
  "Kids Craft Workshop",
  "Photography Walk",
  "Book Club Launch",
  "Film Night: Outdoor Cinema",
  "Yoga in the Park",
  "Parish Council Meeting",
  "Dog Show",
  "Plant Sale",
  "Pub Crawl for Charity",
  "Ceilidh Night",
  "Jumble Sale",
  "Stargazing Evening",
  "Pancake Race",
  "Halloween Trail",
  "Lantern Parade",
  "New Year's Ceilidh",
  "May Day Celebration",
] as const;

/** Demo event descriptions */
export const DEMO_EVENT_DESCRIPTIONS = [
  "A fun evening of trivia and prizes",
  "Annual village celebration with stalls and games",
  "5K run through the village green",
  "Festive market with local crafts and food",
  "Live music from local performers",
  "Celebrating the autumn harvest",
  "Bring your best bakes and compete for the golden whisk",
  "Help keep our village beautiful with a community clean-up",
  "An afternoon of tea, cake, and conversation",
  "Get creative with arts and crafts for ages 5-12",
  "Explore the countryside through a camera lens",
  "Monthly meetup to discuss our latest read",
  "Classic films under the stars, bring blankets and popcorn",
  "Relaxing yoga session suitable for all levels",
  "Your chance to share songs, poems, and stories",
  "A traditional dance evening with live folk music",
  "Show off your four-legged friend and win prizes",
  "Browse affordable second-hand treasures",
  "Join our astronomy group for a night of constellation spotting",
  "A spooky trail through the woods for all ages",
  "Walk through the village with handmade lanterns",
  "Ring in the new year with music, dancing, and haggis",
  "Celebrate spring with maypole dancing and Morris dancers",
  "Pick up bedding plants, herbs, and homegrown veg",
] as const;

/** Demo event locations */
export const DEMO_EVENT_LOCATIONS = [
  "Village Hall, Main Street",
  "The Green, Church Road",
  "Community Centre, Park Lane",
  "St Mary's Church Hall",
  "The Recreation Ground",
  "Memorial Park Pavilion",
  "The Old Barn, Farm Road",
  "Cricket Pavilion, Sports Ground",
  "Library Meeting Room",
  "The Riverside Meadow",
  "Scout Hut, Oak Avenue",
  "Town Square",
  "Allotment Gardens",
  "Primary School Hall",
  "The Anchor Pub, Harbour Street",
  "Bandstand, Victoria Park",
  "Heritage Centre, Market Place",
  "Woodland Trail Car Park",
] as const;

/** Demo group names */
export const DEMO_GROUP_NAMES = [
  "Summer Events",
  "Winter Programme",
  "Community Activities",
  "Youth Club",
  "Charity Fundraisers",
  "Sports & Fitness",
] as const;

/** Demo holiday names */
export const DEMO_HOLIDAY_NAMES = [
  "Bank Holiday",
  "School Half Term",
  "Christmas Break",
  "Easter Weekend",
  "Summer Holidays",
  "Staff Training Day",
] as const;

/** Demo website titles */
export const DEMO_WEBSITE_TITLES = [
  "Village Events",
  "Community Hub",
  "Parish Council Events",
  "Town Hall Bookings",
] as const;

/** Demo page text (homepage / contact) */
export const DEMO_PAGE_TEXT = [
  "Welcome to our community events page. Browse upcoming events and book your tickets online.",
  "Find out about local events in our village. Everyone is welcome to attend!",
  "Your one-stop destination for community events and activities.",
] as const;

/** Demo terms and conditions */
export const DEMO_TERMS = [
  "Tickets are non-refundable. Please arrive 15 minutes before the event start time.",
  "By registering you agree to our community event guidelines. Refunds available up to 48 hours before the event.",
  "All attendees must follow the venue code of conduct. Photography may take place at this event.",
] as const;

// ---------------------------------------------------------------------------
// Field mapping type and pre-built mappings
// ---------------------------------------------------------------------------

/** Maps form field names to arrays of possible demo values */
export type DemoFieldMap = Record<string, readonly string[]>;

/** Attendee PII fields */
export const ATTENDEE_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_NAMES,
  email: DEMO_EMAILS,
  phone: DEMO_PHONES,
  address: DEMO_ADDRESSES,
  special_instructions: DEMO_SPECIAL_INSTRUCTIONS,
};

/** Event metadata fields */
export const EVENT_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_EVENT_NAMES,
  description: DEMO_EVENT_DESCRIPTIONS,
  location: DEMO_EVENT_LOCATIONS,
};

/** Group name field */
export const GROUP_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_GROUP_NAMES,
};

/** Holiday name field */
export const HOLIDAY_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_HOLIDAY_NAMES,
};

/** Site homepage fields */
export const SITE_HOME_DEMO_FIELDS: DemoFieldMap = {
  website_title: DEMO_WEBSITE_TITLES,
  homepage_text: DEMO_PAGE_TEXT,
};

/** Site contact page fields */
export const SITE_CONTACT_DEMO_FIELDS: DemoFieldMap = {
  contact_page_text: DEMO_PAGE_TEXT,
};

/** Terms and conditions field */
export const TERMS_DEMO_FIELDS: DemoFieldMap = {
  terms_and_conditions: DEMO_TERMS,
};

// ---------------------------------------------------------------------------
// Override logic
// ---------------------------------------------------------------------------

/** Pick a random element from an array */
export const randomChoice = <T>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!;

/** Generate a random full name from first name + surname arrays */
export const randomName = (): string =>
  `${randomChoice(DEMO_FIRST_NAMES)} ${randomChoice(DEMO_SURNAMES)}`;

/**
 * Replace form field values with demo data when demo mode is active.
 * Only replaces fields that are present and non-empty in the form.
 * Mutates and returns the same URLSearchParams for chaining.
 */
export const applyDemoOverrides = (
  form: URLSearchParams,
  mapping: DemoFieldMap,
): URLSearchParams => {
  if (!isDemoMode()) return form;
  for (const [field, values] of Object.entries(mapping)) {
    if (form.has(field) && form.get(field) !== "") {
      form.set(field, randomChoice(values));
    }
  }
  return form;
};

/** Wrap a named resource so create/update apply demo overrides to the form */
export const wrapResourceForDemo = <R, I, V extends FieldValues = FieldValues>(
  resource: NamedResource<R, I, V>,
  mapping: DemoFieldMap,
): NamedResource<R, I, V> => ({
  ...resource,
  create: (form) => resource.create(applyDemoOverrides(form, mapping)),
  update: (id, form) => resource.update(id, applyDemoOverrides(form, mapping)),
});

/** Demo mode banner HTML */
export const DEMO_BANNER =
  '<div class="demo-banner">Demo Mode &mdash; entered text is replaced with sample data</div>';
