/**
 * Email template renderer using LiquidJS
 *
 * Renders Liquid templates for registration emails. Templates have access to
 * a safe, explicitly-scoped data object — no access to process.env, filesystem,
 * or network. LiquidJS parses templates to an AST (no eval/new Function).
 */

import type { Liquid } from "liquidjs";
import { lazyRef, map, sumOf } from "#fp";
import { createBaseLiquidEngine } from "#shared/currency.ts";
import {
  addDays,
  formatDateLabel,
  formatDateRangeLabelCompactEn,
} from "#shared/dates.ts";
import { getPackageDisplayForListings } from "#shared/db/groups.ts";
import type {
  EmailTemplateFormat,
  EmailTemplateType,
} from "#shared/db/settings.ts";
import { settings } from "#shared/db/settings.ts";
import type { EmailEntry } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { isPaidListing } from "#shared/types.ts";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { listingNames } from "#templates/email/shared.ts";

/** Create a configured Liquid engine with custom filters */
const createEngine = (): Liquid => {
  const engine = createBaseLiquidEngine();

  engine.registerFilter(
    "pluralize",
    (count: number, singular: string, plural: string) =>
      count === 1 ? singular : plural,
  );

  return engine;
};

/** Lazy-initialized singleton engine instance */
const [getEngine, setEngine] = lazyRef<Liquid>(createEngine);

/** For testing: reset the engine (so filters can be re-registered after currency changes) */
export const resetEngine = (): void => {
  setEngine(null);
};

/** Template entry shape exposed to Liquid templates */
type TemplateEntry = {
  listing: {
    name: string;
    slug: string;
    is_paid: boolean;
  };
  attendee: {
    name: string;
    email: string;
    phone: string;
    address: string;
    special_instructions: string;
    quantity: number;
    price_paid: string;
    date: string | null;
    /** Human-readable booking date (or range for multi-day). Empty string when no date. */
    date_range_label: string;
  };
};

/** Data object passed to Liquid templates */
export type TemplateData = {
  entries: TemplateEntry[];
  listing_names: string;
  attendee: TemplateEntry["attendee"];
  ticket_url: string;
  currency: string;
  /** Order-level outstanding balance in minor units (as a string, for the
   * `currency` filter); "0" when nothing is owed. Positive when a booking was
   * taken without collecting payment (e.g. no payment provider configured). */
  amount_owed: string;
};

/** Map one booking entry to its template shape. */
const toTemplateEntry = ({ listing, attendee }: EmailEntry): TemplateEntry => {
  // Render the booking's actual span from its stored range (end_date is the
  // exclusive end), so customisable-days bookings show the chosen length rather
  // than the listing's maximum duration.
  const lastDay = attendee.end_date ? addDays(attendee.end_date, -1) : null;
  const dateRangeLabel = attendee.date
    ? lastDay && lastDay > attendee.date
      ? formatDateRangeLabelCompactEn(attendee.date, lastDay)
      : formatDateLabel(attendee.date)
    : "";
  return {
    attendee: {
      address: attendee.address,
      date: attendee.date,
      date_range_label: dateRangeLabel,
      email: attendee.email,
      name: attendee.name,
      phone: attendee.phone,
      price_paid: attendee.price_paid,
      quantity: attendee.quantity,
      special_instructions: attendee.special_instructions,
    },
    listing: {
      is_paid: isPaidListing(listing),
      name: listing.name,
      slug: listing.slug,
    },
  };
};

/** A single row standing in for a hidden package's members: the package name,
 * the buyer's contact, and the bundle's summed quantity/price — so the buyer's
 * confirmation never reveals the member listings (the admin email keeps them). */
const collapsedPackageEntry = (
  entries: EmailEntry[],
  packageName: string,
): TemplateEntry => {
  const base = toTemplateEntry(entries[0]!);
  return {
    attendee: {
      ...base.attendee,
      date: null,
      date_range_label: "",
      price_paid: String(
        sumOf((e: EmailEntry) => Number(e.attendee.price_paid))(entries),
      ),
      quantity: sumOf((e: EmailEntry) => e.attendee.quantity)(entries),
    },
    listing: {
      is_paid: entries.some((e) => isPaidListing(e.listing)),
      name: packageName,
      slug: "",
    },
  };
};

/**
 * Build the data object exposed to Liquid templates. When the booking's listings
 * are exactly one package group's members, the package name heads the email
 * (`listing_names`) instead of the member list. `hidePackageMembers` (set for the
 * buyer's confirmation, not the admin notification) collapses a HIDDEN package's
 * member rows into one package row so members aren't revealed.
 */
export const buildTemplateData = async (
  entries: EmailEntry[],
  currency: string,
  ticketUrl: string,
  options: { hidePackageMembers?: boolean } = {},
): Promise<TemplateData> => {
  const pkg = await getPackageDisplayForListings(
    entries.map((e) => e.listing.id),
  );
  const collapse = pkg?.hideListings === true && options.hidePackageMembers;
  const templateEntries: TemplateEntry[] = collapse
    ? [collapsedPackageEntry(entries, pkg.name)]
    : map(toTemplateEntry)(entries);

  return {
    // remaining_balance is order-level (identical on every entry), so read it
    // from the first booking rather than summing across listings.
    amount_owed: String(entries[0]!.attendee.remaining_balance),
    attendee: templateEntries[0]!.attendee,
    currency,
    entries: templateEntries,
    listing_names: pkg ? pkg.name : listingNames(entries),
    ticket_url: ticketUrl,
  };
};

/** Render a single Liquid template string with the given data */
export const renderTemplate = async (
  template: string,
  data: TemplateData,
): Promise<string> => {
  const result = await getEngine().parseAndRender(template, data);
  return result.trim();
};

/** Render all 3 parts (subject, html, text) using custom templates with fallback to defaults */
export const renderEmailContent = async (
  type: EmailTemplateType,
  data: TemplateData,
): Promise<EmailContent> => {
  const defaults = DEFAULT_TEMPLATES[type];
  const custom = settings.email.templateSet(type);

  const [subject, html, text] = await Promise.all([
    safeRender(
      custom.subject || defaults.subject,
      data,
      defaults.subject,
      type,
      "subject",
    ),
    safeRender(custom.html || defaults.html, data, defaults.html, type, "html"),
    safeRender(custom.text || defaults.text, data, defaults.text, type, "text"),
  ]);

  return { html, subject, text };
};

/** Render a template, falling back to default on error */
const safeRender = async (
  template: string,
  data: TemplateData,
  fallbackTemplate: string,
  type: EmailTemplateType,
  format: EmailTemplateFormat,
): Promise<string> => {
  try {
    return await renderTemplate(template, data);
  } catch (error) {
    logError({
      code: ErrorCode.EMAIL_TEMPLATE_RENDER,
      detail: `template render error (${type}/${format}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return await renderTemplate(fallbackTemplate, data);
  }
};

/**
 * Validate a Liquid template by parsing it (no rendering).
 * Returns null if valid, or an error message string if invalid.
 */
export const validateTemplate = (template: string): string | null => {
  try {
    getEngine().parse(template);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
