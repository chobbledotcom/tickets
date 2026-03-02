/**
 * Demo mode - replaces user-entered text with sample data to prevent PII storage.
 * Enable by setting DEMO_MODE=true environment variable.
 */

import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";
import type { NamedResource } from "#lib/rest/resource.ts";
import type { FieldValues } from "#lib/forms.tsx";

// ---------------------------------------------------------------------------
// Demo mode flag
// ---------------------------------------------------------------------------

const [getDemoMode, setDemoMode] = lazyRef(() => getEnv("DEMO_MODE") === "true");

/** Check if demo mode is enabled */
export const isDemoMode = (): boolean => getDemoMode();

/** Reset cached demo mode value (for testing and cache invalidation) */
export const resetDemoMode = (): void => setDemoMode(null);

// ---------------------------------------------------------------------------
// Sample data arrays
// ---------------------------------------------------------------------------

/** Demo attendee names */
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
] as const;

/** Demo addresses */
export const DEMO_ADDRESSES = [
  "1 High Street, London, SW1A 1AA",
  "2 Main Road, Manchester, M1 1AA",
  "3 Church Lane, Bristol, BS1 1AA",
  "4 Park Avenue, Leeds, LS1 1AA",
  "5 Station Road, Birmingham, B1 1AA",
] as const;

/** Demo special instructions */
export const DEMO_SPECIAL_INSTRUCTIONS = [
  "No special requirements",
  "Wheelchair access needed",
  "Vegetarian meal please",
  "Requires parking space",
  "Bringing a guide dog",
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
] as const;

/** Demo event descriptions */
export const DEMO_EVENT_DESCRIPTIONS = [
  "A fun evening of trivia and prizes",
  "Annual village celebration with stalls and games",
  "5K run through the village green",
  "Festive market with local crafts and food",
  "Live music from local performers",
  "Celebrating the autumn harvest",
] as const;

/** Demo event locations */
export const DEMO_EVENT_LOCATIONS = [
  "Village Hall, Main Street",
  "The Green, Church Road",
  "Community Centre, Park Lane",
  "St Mary's Church Hall",
  "The Recreation Ground",
  "Memorial Park Pavilion",
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
const randomChoice = <T>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!;

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
  '<div class="demo-banner">Demo Mode \u2014 entered text is replaced with sample data</div>';
