/**
 * Email template renderer using LiquidJS
 *
 * Renders Liquid templates for registration emails. Templates have access to
 * a safe, explicitly-scoped data object — no access to process.env, filesystem,
 * or network. LiquidJS parses templates to an AST (no eval/new Function).
 */

import type { Liquid } from "liquidjs";
import { lazyRef, map, sumOf } from "#fp";
import { bookedRangeLabel, widestDatedEntry } from "#shared/dates.ts";
import {
  type PackageDisplay,
  packageDisplaysForRows,
} from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import type { EmailEntry } from "#shared/email.ts";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  type ContactInfo,
  type EmailTemplateFormat,
  type EmailTemplateType,
  isPaidListing,
  normalizeDurationDays,
} from "#shared/types.ts";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { nameList } from "#templates/email/shared.ts";

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
  attendee: ContactInfo & {
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

/** Whether an entry's price cell should render. A package override can charge a
 * member whose base listing is free, so the booking's actual `price_paid` makes
 * the row paid even when `isPaidListing(listing)` is false. */
const entryIsPaid = ({ listing, attendee }: EmailEntry): boolean =>
  isPaidListing(listing) || Number(attendee.price_paid) > 0;

/** Map one booking entry to its template shape. */
const toTemplateEntry = (entry: EmailEntry): TemplateEntry => {
  const { listing, attendee } = entry;
  // Render the booking's actual span from its stored range, so customisable-days
  // bookings show the chosen length rather than the listing's maximum duration
  // (legacy rows without a stored end fall back to the listing's fixed span).
  const dateRangeLabel = bookedRangeLabel(
    attendee.date,
    attendee.end_date,
    normalizeDurationDays(listing.duration_days),
  );
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
      is_paid: entryIsPaid(entry),
      name: listing.name,
      slug: listing.slug,
    },
  };
};

/** The buyer's summed price (minor units) across an order's entries. */
export const sumEntryPrices = (entries: EmailEntry[]): number =>
  sumOf((e: EmailEntry) => Number(e.attendee.price_paid))(entries);

/** The bundle's summed booked quantity across an order's entries. */
export const sumEntryQuantities = (entries: EmailEntry[]): number =>
  sumOf((e: EmailEntry) => e.attendee.quantity)(entries);

/** The single-row summary a hidden package collapses to for buyers: the
 * bundle's summed price and quantity plus the widest member's dated stay
 * (hiding members must not lose the date the buyer booked). Shared by the
 * email body row and the SVG ticket, so the two can never disagree. */
export const collapsedPackageSummary = (
  entries: EmailEntry[],
): {
  pricePaid: string;
  quantity: number;
  widestDated: EmailEntry | null;
} => ({
  pricePaid: String(sumEntryPrices(entries)),
  quantity: sumEntryQuantities(entries),
  widestDated: widestDatedEntry(entries),
});

/** One buyer-facing row group: a HIDDEN package's rows gather behind its name;
 * every other row stands alone. */
export type BuyerEntryGroup = {
  entries: EmailEntry[];
  hiddenPackageName?: string;
};

/** One walked group: a collapsed package's rows carry its display; a row that
 * stands alone carries none. */
type EntryGroup = { entries: EmailEntry[]; display?: PackageDisplay };

/** Walk an order's entries once, gathering every package that `collapses` into
 * one group sitting where its first row was; every other row stands alone. The
 * one place the entry→display walk lives — the buyer grouping and the heading
 * names below are both maps over it. */
const entryGroupsBy = (
  entries: EmailEntry[],
  displays: ReadonlyMap<number, PackageDisplay>,
  collapses: (display: PackageDisplay) => boolean,
): EntryGroup[] => {
  const groups: EntryGroup[] = [];
  const collapsedByGroupId = new Map<number, EntryGroup>();
  for (const entry of entries) {
    const display = displays.get(entry.attendee.package_group_id);
    if (display === undefined || !collapses(display)) {
      groups.push({ entries: [entry] });
      continue;
    }
    const started = collapsedByGroupId.get(entry.attendee.package_group_id);
    if (started) {
      started.entries.push(entry);
      continue;
    }
    const group = { display, entries: [entry] };
    collapsedByGroupId.set(entry.attendee.package_group_id, group);
    groups.push(group);
  }
  return groups;
};

/** Group an order's entries for buyer-facing rendering (the confirmation body
 * and its SVG tickets): each hidden package's rows collapse into one group
 * sitting where its first row was, so a mixed order conceals every hidden
 * bundle while its other rows render normally. */
export const buyerEntryGroups = (
  entries: EmailEntry[],
  displays: ReadonlyMap<number, PackageDisplay>,
): BuyerEntryGroup[] =>
  map(
    (group: EntryGroup): BuyerEntryGroup =>
      group.display === undefined
        ? { entries: group.entries }
        : { entries: group.entries, hiddenPackageName: group.display.name },
  )(entryGroupsBy(entries, displays, (display) => display.hideListings));

/** The names heading the email: each package once (by its display name, in
 * first-booked order — hidden or not) beside the plain rows' listing names. */
const orderDisplayNames = (
  entries: EmailEntry[],
  displays: ReadonlyMap<number, PackageDisplay>,
): string =>
  nameList(
    map((group: EntryGroup) =>
      group.display === undefined
        ? group.entries[0]!.listing.name
        : group.display.name,
    )(entryGroupsBy(entries, displays, () => true)),
  );

/** A single row standing in for a hidden package's members: the package name,
 * the buyer's contact, and the bundle's summed quantity/price — so the buyer's
 * confirmation never reveals the member listings (the admin email keeps them). */
const collapsedPackageEntry = (
  entries: EmailEntry[],
  packageName: string,
): TemplateEntry => {
  const base = toTemplateEntry(entries[0]!);
  const summary = collapsedPackageSummary(entries);
  const dated = summary.widestDated
    ? toTemplateEntry(summary.widestDated).attendee
    : null;
  return {
    attendee: {
      ...base.attendee,
      date: dated?.date ?? null,
      date_range_label: dated?.date_range_label ?? "",
      price_paid: summary.pricePaid,
      quantity: summary.quantity,
    },
    listing: {
      is_paid: entries.some(entryIsPaid),
      name: packageName,
      slug: "",
    },
  };
};

/**
 * Build the data object exposed to Liquid templates. Rows booked through a
 * package head the email by the package's name (`listing_names`); an order may
 * carry several bundles beside plain rows. `hidePackageMembers` (set for the
 * buyer's confirmation, not the admin notification) collapses each HIDDEN
 * package's member rows into one package row so members aren't revealed —
 * whatever else the order carries beside them.
 */
export const buildTemplateData = async (
  entries: EmailEntry[],
  currency: string,
  ticketUrl: string,
  options: { hidePackageMembers?: boolean } = {},
): Promise<TemplateData> => {
  const displays = await packageDisplaysForRows(entries);
  // The buyer's confirmation (hidePackageMembers) collapses hidden packages'
  // rows; the admin notification keeps them.
  const templateEntries: TemplateEntry[] = options.hidePackageMembers
    ? buyerEntryGroups(entries, displays).map((group) =>
        group.hiddenPackageName === undefined
          ? toTemplateEntry(group.entries[0]!)
          : collapsedPackageEntry(group.entries, group.hiddenPackageName),
      )
    : map(toTemplateEntry)(entries);

  return {
    // remaining_balance is order-level (identical on every entry), so read it
    // from the first booking rather than summing across listings.
    amount_owed: String(entries[0]!.attendee.remaining_balance),
    attendee: templateEntries[0]!.attendee,
    currency,
    entries: templateEntries,
    listing_names: orderDisplayNames(entries, displays),
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
