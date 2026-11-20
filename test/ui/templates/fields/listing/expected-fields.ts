/**
 * The exact field lists the listing form builders promise, written out
 * literally so a changed name, label, hint, bound, flag, or choice fails the
 * schema tests instead of moving the expectation along with it.
 */

/** The text input of a ticket money field, with a 10.00 example. */
const MONEY_TEXT = {
  inputmode: "decimal",
  pattern: "\\d+(\\.\\d{1,2})?",
  placeholder: "e.g. 10.00",
  title: "A non-negative number (e.g. 10.00)",
  type: "text",
} as const;

/* jscpd:ignore-start -- a list of strings, not code */
const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const INTERVAL_CHOICES = [
  ["Never", ""],
  ["Week", "week"],
  ["Month", "month"],
  ["Year", "year"],
] as const;
/* jscpd:ignore-end */

// The expected fields are written out literally so a changed name, label,
// hint, bound, flag, or choice fails here instead of moving along with it.
/* jscpd:ignore-start -- a list of field records, not code */
export const LISTING_FIELDS = [
  {
    hint: "Displayed to buyers on the listing page",
    label: "Listing name",
    name: "name",
    placeholder: "Village Quiz Night",
    required: true,
    section: "basics",
    type: "text",
  },
  {
    hint: "Daily listings require buyers to select a specific date when booking",
    invalidMessage: "Listing type must be standard or daily.",
    label: "Listing type",
    name: "listingType",
    options: [
      {
        label: "Standard",
        value: "standard",
      },
      {
        label: "Daily",
        value: "daily",
      },
    ],
    section: "basics",
    type: "select",
  },
  {
    hint: "Shown on the listing page.",
    label: "Description (optional)",
    name: "description",
    placeholder: "A short description of the listing",
    section: "basics",
    type: "textarea",
  },
  {
    hint: "When the listing takes place. Times are in your configured timezone.",
    label: "Listing date (optional)",
    name: "date",
    section: "basics",
    type: "datetime",
  },
  {
    hint: "Where the listing takes place. Shown on the listing page.",
    label: "Location (optional)",
    name: "location",
    placeholder: "e.g. Village Hall, Main Street",
    section: "basics",
    type: "text",
  },
  {
    hint: "For daily listings, this limit applies per date",
    label: "Max items",
    min: 1,
    name: "maxAttendees",
    required: true,
    section: "tickets",
    type: "number",
  },
  {
    defaultValue: "1",
    hint: "Maximum items a buyer can buy in one transaction",
    label: "Max items per purchase",
    min: 1,
    name: "maxQuantity",
    required: true,
    section: "tickets",
    type: "number",
  },
  {
    defaultValue: "1",
    hint: "Minimum items a buyer can buy in one transaction",
    label: "Min items per purchase",
    min: 1,
    name: "minQuantity",
    required: true,
    section: "tickets",
    type: "number",
  },
  {
    hint: "Select which days of the week are available for booking",
    label: "Bookable days (for daily listings)",
    name: "bookableDays",
    options: WEEKDAYS.map((day) => ({ label: day, value: day })),
    section: "daily",
    type: "checkbox-group",
  },
  {
    defaultValue: "1",
    hint: "How many days in advance buyers must book (0 = same day)",
    label: "Minimum days notice (for daily listings)",
    min: 0,
    name: "minimumDaysBefore",
    required: true,
    section: "daily",
    type: "number",
  },
  {
    defaultValue: "90",
    hint: "How far into the future buyers can book (0 = no limit)",
    label: "Maximum days ahead (for daily listings)",
    min: 0,
    name: "maximumDaysAfter",
    required: true,
    section: "daily",
    type: "number",
  },
  {
    defaultValue: "1",
    hint: "How many days each booking reserves. With Customisable days on, this is the maximum a visitor can choose. Only applies to daily listings unless Customisable days is on.",
    label: "Booking duration (days)",
    max: 90,
    min: 1,
    name: "durationDays",
    required: true,
    section: "duration",
    type: "number",
  },
  {
    hint: "Let visitors choose how many days to book (1 up to the Booking duration above), each priced separately below. Works for standard and daily listings. Cannot be combined with Allow pay more.",
    label: "Customisable days",
    name: "customisableDays",
    options: [
      {
        label: "Let visitors choose the number of days",
        value: "1",
      },
    ],
    section: "customisable",
    type: "checkbox-group",
  },
  {
    hint: "Which contact details to collect from buyers",
    label: "Contact fields",
    name: "fields",
    options: [
      {
        label: "Email",
        value: "email",
      },
      {
        label: "Phone number",
        value: "phone",
      },
      {
        label: "Address",
        value: "address",
      },
      {
        label: "Special instructions",
        value: "special_instructions",
      },
    ],
    section: "options",
    type: "checkbox-group",
  },
  {
    inputmode: "decimal",
    label: "Item price",
    name: "unitPrice",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 10.00",
    required: true,
    requiredMessage: "Enter a price for the item. Type 0 for free.",
    section: "tickets",
    title: "A non-negative number (e.g. 10.00)",
    type: "text",
  },
  {
    hint: "Let buyers pay more than the item price (the price above becomes a minimum)",
    label: "Allow pay more",
    name: "canPayMore",
    options: [
      {
        label: "Allow buyers to set their own price",
        value: "1",
      },
    ],
    section: "tickets",
    type: "checkbox-group",
  },
  {
    ...MONEY_TEXT,
    hint: "Stripe charges this again each period, from one period after the first payment. VAT follows your tax settings. The first payment is the item price.",
    label: "Recurring price (leave empty for an ordinary item)",
    name: "recurringPrice",
    section: "tickets",
    visible: false,
  },
  {
    hint: "How often Stripe charges the recurring price.",
    label: "Charge again every",
    name: "recurringInterval",
    options: INTERVAL_CHOICES.map(([label, value]) => ({ label, value })),
    section: "tickets",
    type: "select",
    visible: false,
  },
  {
    defaultValue: "100.00",
    hint: "The maximum price buyers can pay. Must be at least £1 more than the item price.",
    inputmode: "decimal",
    label: "Maximum price (for pay more)",
    name: "maxPrice",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 100.00",
    required: true,
    requiredMessage: "Enter a maximum price. Type 0 for no maximum.",
    section: "tickets",
    title: "A non-negative number (e.g. 100.00)",
    type: "text",
  },
  {
    hint: "Leave blank for no deadline. Times are in your configured timezone.",
    label: "Registration closes at (optional)",
    name: "closesAt",
    section: "tickets",
    type: "datetime",
  },
  {
    hint: "Leave blank to show a simple success message",
    label: "Thank you URL (optional)",
    name: "thankYouUrl",
    placeholder: "https://example.com/thank-you",
    section: "advanced",
    type: "url",
  },
  {
    hint: "Receives POST with buyer name, email, and phone on registration",
    label: "Webhook URL (optional)",
    name: "webhookUrl",
    placeholder: "https://example.com/webhook",
    section: "advanced",
    type: "url",
    visible: true,
  },
  {
    hint: "Requires buyers to show ID matching the item name at entry",
    label: "Non-transferable items",
    name: "nonTransferable",
    options: [
      {
        label: "No",
        value: "",
      },
      {
        label: "Yes",
        value: "1",
      },
    ],
    section: "options",
    type: "select",
  },
  {
    hint: "Hide from the public listings page and search engines. The listing is still bookable via its direct link. A group page can still show it when that group allows hidden listings.",
    label: "Hidden listing",
    name: "hidden",
    options: [
      {
        label: "Hide from public listings list",
        value: "1",
      },
    ],
    section: "options",
    type: "checkbox-group",
  },
  {
    hint: "For items people buy without being checked in, such as raffles, fundraisers, donations, merch, or digital products. Hides QR codes, check-in, and wallet passes. Shows ‘Buy now’ instead of ‘Reserve’.",
    label: "No check-in",
    name: "purchaseOnly",
    options: [
      {
        label: "Disable check-in for this item",
        value: "1",
      },
    ],
    section: "options",
    type: "checkbox-group",
  },
  {
    hint: "Only matters when this listing is offered under one or more parents. Keeps its own booking page, catalogue entry and API eligibility so it can be sold on its own, as well as folded into its parents. Off (the default) means being a child hides its standalone page.",
    label: "Can be booked by itself",
    name: "bookableAlone",
    options: [
      {
        label:
          "Keep this listing's own booking page while it is offered under others",
        value: "1",
      },
    ],
    section: "options",
    type: "checkbox-group",
  },
  {
    hint: "Handled by an agent at the customer's location. Start and end agent selectors appear for buyers (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
    label: "Needs logistics",
    name: "usesLogistics",
    options: [
      {
        label: "Assign agents to this listing's bookings",
        value: "1",
      },
    ],
    section: "options",
    type: "checkbox-group",
    visible: false,
  },
  {
    defaultValue: "0",
    hint: "How many months one item buys. Leave 0 for non-renewal listings.",
    label: "Months per unit (renewal tiers only)",
    max: 24,
    min: 0,
    name: "monthsPerUnit",
    required: true,
    section: "advanced",
    type: "number",
    visible: false,
  },
  {
    defaultValue: "0",
    hint: "How many months the site starts with for each unit bought. Required when assigning a built site.",
    label: "Initial site months (built site listings only)",
    max: 120,
    min: 0,
    name: "initialSiteMonths",
    required: true,
    section: "advanced",
    type: "number",
    visible: false,
  },
  {
    hint: "Automatically assign a site when someone books this listing. Quantity buys months, not extra sites.",
    label: "Assign built site",
    name: "assignBuiltSite",
    options: [
      {
        label: "Assign a site on booking",
        value: "1",
      },
    ],
    section: "advanced",
    type: "checkbox-group",
    visible: false,
  },
  {
    label: "Attachment (any file — max 25MB)",
    name: "attachment",
    section: "basics",
    type: "file",
    visible: false,
  },
];
/* jscpd:ignore-end */

export const SLUG_FIELD = {
  hint: "URL-friendly identifier (lowercase letters, numbers, hyphens, and underscores). Changing this will break any existing links, embeds, or QR codes that point to this page. Only change if you know what you're doing.",
  label: "Slug",
  name: "slug",
  pattern: "[a-z0-9_\\-]+",
  required: true,
  section: "advanced",
  title: "Lowercase letters, numbers, hyphens, and underscores only",
  type: "text",
};
