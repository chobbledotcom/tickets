import { parsePositiveInt } from "#shared/validation/number.ts";

const DEFAULT_PORT = 12111;

/** Read the optional stripe-mock port without accepting partial numbers. */
const port = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  const port = parsePositiveInt(value);
  if (port === null || port > 65_535) {
    throw new Error("STRIPE_MOCK_PORT must be a number from 1 to 65535");
  }
  return port;
};

/** Shared stripe-mock defaults and strict environment parsing. */
export const stripeMock = { defaultPort: DEFAULT_PORT, port };
