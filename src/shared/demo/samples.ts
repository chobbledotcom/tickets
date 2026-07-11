/**
 * Sample data pools for demo mode and seeding.
 *
 * These arrays (and the generated listing pools) replace user-entered text
 * when demo mode is on, and feed the database seeder. Only code that writes
 * demo values should import this module — the per-render demo check lives in
 * `#shared/demo/mode.ts` so pages never load these pools.
 */

import {
  DEFAULT_BAND_SEED,
  DEFAULT_DESCRIPTION_SEED,
  DEFAULT_VENUE_SEED,
  generateBandNames,
  generateDescriptions,
  generateVenueNames,
} from "#shared/band-name-generator.ts";

/** Pick a random element from an array */
export const randomChoice = <T>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!;

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

/** Demo servicing-event names (a reason/job for a capacity hold, not a person) */
export const DEMO_SERVICING_NAMES = [
  "Boiler Service",
  "Deep Clean",
  "Annual Inspection",
  "Fire Alarm Test",
  "Carpet Cleaning",
  "Window Cleaning",
  "Pest Control Visit",
  "PAT Testing",
  "Gas Safety Check",
  "Electrical Inspection",
  "Staff Training Day",
  "Private Hire",
  "Maintenance Window",
  "Equipment Repair",
  "Lift Servicing",
  "Plumbing Repair",
  "Painting & Decorating",
  "Floor Resurfacing",
  "Air Conditioning Service",
  "Stocktake",
  "Health & Safety Audit",
  "Deep Sanitisation",
  "Roof Repair",
  "Garden Maintenance",
  "Security Upgrade",
  "Furniture Delivery",
  "Photography Shoot",
  "Film Crew Booking",
  "Staff Meeting",
  "Closed for Refurbishment",
  "Kitchen Deep Clean",
  "Drain Cleaning",
  "Emergency Repair",
  "Network Upgrade",
  "CCTV Installation",
  "Heating Repair",
  "Locksmith Visit",
  "Waste Collection",
  "Building Survey",
  "Damp Treatment",
  "Guttering Clean",
  "Signage Installation",
  "AV Equipment Setup",
  "Stage Construction",
  "Marquee Setup",
  "Grounds Maintenance",
  "Window Replacement",
  "Asbestos Survey",
  "Insurance Inspection",
  "Stage Lighting Focus",
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

/**
 * Demo listing names — pretend rock/heavy-metal band listings.
 * Generated procedurally from a seeded PRNG so the list stays deterministic
 * across runs (tests rely on this) but offers far more variety than a
 * hand-curated list while staying on-theme.
 */
export const DEMO_LISTING_NAMES = generateBandNames(
  60,
  DEFAULT_BAND_SEED,
) as readonly string[];

/**
 * Demo listing descriptions — rock-themed gig blurbs assembled from word pools.
 * Like the names above, the list is procedurally generated but seeded so it
 * stays deterministic across runs.
 */
export const DEMO_LISTING_DESCRIPTIONS = generateDescriptions(
  40,
  DEFAULT_DESCRIPTION_SEED,
) as readonly string[];

/**
 * Demo listing locations — pretend rock-venue / festival listings.
 * Procedurally generated from the venue word pools using a seeded PRNG.
 */
export const DEMO_LISTING_LOCATIONS = generateVenueNames(
  40,
  DEFAULT_VENUE_SEED,
) as readonly string[];

/** Demo group names */
export const DEMO_GROUP_NAMES = [
  "Summer Listings",
  "Winter Programme",
  "Community Activities",
  "Youth Club",
  "Charity Fundraisers",
  "Sports & Fitness",
] as const;

/** Demo group descriptions */
export const DEMO_GROUP_DESCRIPTIONS = [
  "A collection of summer activities for the whole family",
  "Warm up with our winter programme of listings",
  "Community-led activities open to all",
  "Fun activities for young people aged 11-18",
  "Help us raise money for local causes",
  "Stay active with our sports and fitness listings",
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
  "Village Listings",
  "Community Hub",
  "Parish Council Listings",
  "Town Hall Bookings",
] as const;

/** Demo page text (homepage / contact) */
export const DEMO_PAGE_TEXT = [
  "Welcome to our community listings page. Browse upcoming listings and book your tickets online.",
  "Find out about local listings in our village. Everyone is welcome to attend!",
  "Your one-stop destination for community listings and activities.",
] as const;

/** Demo terms and conditions */
export const DEMO_TERMS = [
  "Tickets are non-refundable. Please arrive 15 minutes before the listing start time.",
  "By registering you agree to our community listing guidelines. Refunds available up to 48 hours before the listing.",
  "All attendees must follow the venue code of conduct. Photography may take place at this listing.",
] as const;
