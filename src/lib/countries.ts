/**
 * Country configuration for timezone, currency, and phone prefix.
 * Add new countries as needed — each entry maps an ISO 3166-1 alpha-2
 * country code to its default timezone, currency, and calling code.
 */

export type CountryData = {
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phonePrefix: string;
};

export const COUNTRIES: Record<string, CountryData> = {
  GB: {
    name: "United Kingdom",
    timezone: "Europe/London",
    currency: "GBP",
    phonePrefix: "44",
  },
  US: {
    name: "United States",
    timezone: "America/New_York",
    currency: "USD",
    phonePrefix: "1",
  },
  CA: {
    name: "Canada",
    timezone: "America/Toronto",
    currency: "CAD",
    phonePrefix: "1",
  },
  AU: {
    name: "Australia",
    timezone: "Australia/Sydney",
    currency: "AUD",
    phonePrefix: "61",
  },
  NZ: {
    name: "New Zealand",
    timezone: "Pacific/Auckland",
    currency: "NZD",
    phonePrefix: "64",
  },
  IE: {
    name: "Ireland",
    timezone: "Europe/Dublin",
    currency: "EUR",
    phonePrefix: "353",
  },
  FR: {
    name: "France",
    timezone: "Europe/Paris",
    currency: "EUR",
    phonePrefix: "33",
  },
  DE: {
    name: "Germany",
    timezone: "Europe/Berlin",
    currency: "EUR",
    phonePrefix: "49",
  },
  ES: {
    name: "Spain",
    timezone: "Europe/Madrid",
    currency: "EUR",
    phonePrefix: "34",
  },
  IT: {
    name: "Italy",
    timezone: "Europe/Rome",
    currency: "EUR",
    phonePrefix: "39",
  },
  NL: {
    name: "Netherlands",
    timezone: "Europe/Amsterdam",
    currency: "EUR",
    phonePrefix: "31",
  },
  BE: {
    name: "Belgium",
    timezone: "Europe/Brussels",
    currency: "EUR",
    phonePrefix: "32",
  },
  PT: {
    name: "Portugal",
    timezone: "Europe/Lisbon",
    currency: "EUR",
    phonePrefix: "351",
  },
  AT: {
    name: "Austria",
    timezone: "Europe/Vienna",
    currency: "EUR",
    phonePrefix: "43",
  },
  CH: {
    name: "Switzerland",
    timezone: "Europe/Zurich",
    currency: "CHF",
    phonePrefix: "41",
  },
  SE: {
    name: "Sweden",
    timezone: "Europe/Stockholm",
    currency: "SEK",
    phonePrefix: "46",
  },
  NO: {
    name: "Norway",
    timezone: "Europe/Oslo",
    currency: "NOK",
    phonePrefix: "47",
  },
  DK: {
    name: "Denmark",
    timezone: "Europe/Copenhagen",
    currency: "DKK",
    phonePrefix: "45",
  },
  FI: {
    name: "Finland",
    timezone: "Europe/Helsinki",
    currency: "EUR",
    phonePrefix: "358",
  },
  JP: {
    name: "Japan",
    timezone: "Asia/Tokyo",
    currency: "JPY",
    phonePrefix: "81",
  },
  SG: {
    name: "Singapore",
    timezone: "Asia/Singapore",
    currency: "SGD",
    phonePrefix: "65",
  },
  IN: {
    name: "India",
    timezone: "Asia/Kolkata",
    currency: "INR",
    phonePrefix: "91",
  },
  ZA: {
    name: "South Africa",
    timezone: "Africa/Johannesburg",
    currency: "ZAR",
    phonePrefix: "27",
  },
};

export const DEFAULT_COUNTRY = "GB";

/** Get country data, falling back to the default country (GB). */
export const getCountry = (code: string): CountryData =>
  COUNTRIES[code] ?? COUNTRIES[DEFAULT_COUNTRY]!;

/** Check if a country code is valid (exists in the list). */
export const isValidCountry = (code: string): boolean => code in COUNTRIES;
