/**
 * The exact field lists the listing form builders promise, written out
 * literally so a changed name, label, hint, bound, flag, or choice fails the
 * schema tests instead of moving the expectation along with it.
 */

// The expected fields are written out literally so a changed name, label,
// hint, bound, flag, or choice fails here instead of moving along with it.
export const LISTING_FIELDS = [
  {
    hint: "Displayed to attendees on the ticket page",
    label: "Listing name",
    name: "name",
    placeholder: "Village Quiz Night",
    required: true,
    section: "basics",
    type: "text",
  },
  {
    hint: "Daily listings require attendees to select a specific date when booking",
    invalidMessage: "Listing type must be standard or daily",
    label: "Listing type",
    name: "listing_type",
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
    hint: "Shown on the ticket page.",
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
    hint: "Where the listing takes place. Shown on the ticket page.",
    label: "Location (optional)",
    name: "location",
    placeholder: "e.g. Village Hall, Main Street",
    section: "basics",
    type: "text",
  },
  {
    hint: "For daily listings, this limit applies per date",
    label: "Max attendees",
    min: 1,
    name: "max_attendees",
    required: true,
    section: "tickets",
    type: "number",
  },
  {
    hint: "Maximum tickets a customer can buy in one transaction",
    label: "Max tickets per purchase",
    min: 1,
    name: "max_quantity",
    required: true,
    section: "tickets",
    type: "number",
  },
  {
    hint: "Select which days of the week are available for booking",
    label: "Bookable days (for daily listings)",
    name: "bookable_days",
    options: [
      {
        label: "Monday",
        value: "Monday",
      },
      {
        label: "Tuesday",
        value: "Tuesday",
      },
      {
        label: "Wednesday",
        value: "Wednesday",
      },
      {
        label: "Thursday",
        value: "Thursday",
      },
      {
        label: "Friday",
        value: "Friday",
      },
      {
        label: "Saturday",
        value: "Saturday",
      },
      {
        label: "Sunday",
        value: "Sunday",
      },
    ],
    section: "daily",
    type: "checkbox-group",
  },
  {
    hint: "How many days in advance attendees must book (0 = same day)",
    label: "Minimum days notice (for daily listings)",
    min: 0,
    name: "minimum_days_before",
    section: "daily",
    type: "number",
  },
  {
    hint: "How far into the future attendees can book (0 = no limit)",
    label: "Maximum days ahead (for daily listings)",
    min: 0,
    name: "maximum_days_after",
    section: "daily",
    type: "number",
  },
  {
    hint: "How many days each booking reserves. With Customisable Days on, this is the maximum a visitor can choose. Only applies to daily listings unless Customisable Days is on.",
    label: "Booking duration (days)",
    max: 90,
    min: 1,
    name: "duration_days",
    section: "duration",
    type: "number",
  },
  {
    hint: "Let visitors choose how many days to book (1 up to the Booking Duration above), each priced separately below. Works for standard and daily listings. Cannot be combined with Allow Pay More.",
    label: "Customisable days",
    name: "customisable_days",
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
    hint: "Which contact details to collect from attendees",
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
    label: "Ticket price (leave empty for free)",
    name: "unit_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 10.00",
    section: "tickets",
    title: "A non-negative number (e.g. 10.00)",
    type: "text",
  },
  {
    hint: "Let attendees pay more than the ticket price (the price above becomes a minimum)",
    label: "Allow pay more",
    name: "can_pay_more",
    options: [
      {
        label: "Allow attendees to set their own price",
        value: "1",
      },
    ],
    section: "tickets",
    type: "checkbox-group",
  },
  {
    defaultValue: "100.00",
    hint: "The maximum price attendees can pay. Must be at least £1 more than the ticket price.",
    inputmode: "decimal",
    label: "Maximum price (for pay more)",
    name: "max_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 100.00",
    section: "tickets",
    title: "A non-negative number (e.g. 100.00)",
    type: "text",
  },
  {
    hint: "Leave blank for no deadline. Times are in your configured timezone.",
    label: "Registration closes at (optional)",
    name: "closes_at",
    section: "tickets",
    type: "datetime",
  },
  {
    hint: "Leave blank to show a simple success message",
    label: "Thank you URL (optional)",
    name: "thank_you_url",
    placeholder: "https://example.com/thank-you",
    section: "advanced",
    type: "url",
  },
  {
    hint: "Receives POST with attendee name, email, and phone on registration",
    label: "Webhook URL (optional)",
    name: "webhook_url",
    placeholder: "https://example.com/webhook",
    section: "advanced",
    type: "url",
    visible: true,
  },
  {
    hint: "Requires attendees to show ID matching the ticket name at entry",
    label: "Non-transferable tickets",
    name: "non_transferable",
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
    hint: "Hide from the public listings page and search engines. The listing is still bookable via its direct link.",
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
    name: "purchase_only",
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
    name: "bookable_alone",
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
    hint: "Handled by an agent at the customer's location. Attendees gain start and end agent selectors (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
    label: "Needs logistics",
    name: "uses_logistics",
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
    hint: "How many months one ticket buys. Leave 0 for non-renewal listings.",
    label: "Months per unit (renewal tiers only)",
    max: 24,
    min: 0,
    name: "months_per_unit",
    section: "advanced",
    type: "number",
    visible: false,
  },
  {
    hint: "How many months the site stays active after purchase. Required when assigning a built site.",
    label: "Initial site months (built site listings only)",
    max: 120,
    min: 0,
    name: "initial_site_months",
    section: "advanced",
    type: "number",
    visible: false,
  },
  {
    hint: "Automatically assign a built site to each ticket purchased for this listing",
    label: "Assign built site",
    name: "assign_built_site",
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
