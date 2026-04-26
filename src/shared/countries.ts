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
  AT: {
    currency: "EUR",
    name: "Austria",
    phonePrefix: "43",
    timezone: "Europe/Vienna",
  },
  AU: {
    currency: "AUD",
    name: "Australia",
    phonePrefix: "61",
    timezone: "Australia/Sydney",
  },
  BE: {
    currency: "EUR",
    name: "Belgium",
    phonePrefix: "32",
    timezone: "Europe/Brussels",
  },
  CA: {
    currency: "CAD",
    name: "Canada",
    phonePrefix: "1",
    timezone: "America/Toronto",
  },
  CH: {
    currency: "CHF",
    name: "Switzerland",
    phonePrefix: "41",
    timezone: "Europe/Zurich",
  },
  DE: {
    currency: "EUR",
    name: "Germany",
    phonePrefix: "49",
    timezone: "Europe/Berlin",
  },
  DK: {
    currency: "DKK",
    name: "Denmark",
    phonePrefix: "45",
    timezone: "Europe/Copenhagen",
  },
  ES: {
    currency: "EUR",
    name: "Spain",
    phonePrefix: "34",
    timezone: "Europe/Madrid",
  },
  FI: {
    currency: "EUR",
    name: "Finland",
    phonePrefix: "358",
    timezone: "Europe/Helsinki",
  },
  FR: {
    currency: "EUR",
    name: "France",
    phonePrefix: "33",
    timezone: "Europe/Paris",
  },
  GB: {
    currency: "GBP",
    name: "United Kingdom",
    phonePrefix: "44",
    timezone: "Europe/London",
  },
  IE: {
    currency: "EUR",
    name: "Ireland",
    phonePrefix: "353",
    timezone: "Europe/Dublin",
  },
  IN: {
    currency: "INR",
    name: "India",
    phonePrefix: "91",
    timezone: "Asia/Kolkata",
  },
  IT: {
    currency: "EUR",
    name: "Italy",
    phonePrefix: "39",
    timezone: "Europe/Rome",
  },
  JP: {
    currency: "JPY",
    name: "Japan",
    phonePrefix: "81",
    timezone: "Asia/Tokyo",
  },
  NL: {
    currency: "EUR",
    name: "Netherlands",
    phonePrefix: "31",
    timezone: "Europe/Amsterdam",
  },
  NO: {
    currency: "NOK",
    name: "Norway",
    phonePrefix: "47",
    timezone: "Europe/Oslo",
  },
  NZ: {
    currency: "NZD",
    name: "New Zealand",
    phonePrefix: "64",
    timezone: "Pacific/Auckland",
  },
  PT: {
    currency: "EUR",
    name: "Portugal",
    phonePrefix: "351",
    timezone: "Europe/Lisbon",
  },
  SE: {
    currency: "SEK",
    name: "Sweden",
    phonePrefix: "46",
    timezone: "Europe/Stockholm",
  },
  SG: {
    currency: "SGD",
    name: "Singapore",
    phonePrefix: "65",
    timezone: "Asia/Singapore",
  },
  US: {
    currency: "USD",
    name: "United States",
    phonePrefix: "1",
    timezone: "America/New_York",
  },
  ZA: {
    currency: "ZAR",
    name: "South Africa",
    phonePrefix: "27",
    timezone: "Africa/Johannesburg",
  },
};

export const DEFAULT_COUNTRY = "GB";

/** Get country data, falling back to the default country (GB). */
export const getCountry = (code: string): CountryData =>
  COUNTRIES[code] ?? COUNTRIES[DEFAULT_COUNTRY]!;

/** Check if a country code is valid (exists in the list). */
export const isValidCountry = (code: string): boolean => code in COUNTRIES;
