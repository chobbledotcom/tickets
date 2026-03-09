/**
 * Email template renderer using LiquidJS
 *
 * Renders Liquid templates for registration emails. Templates have access to
 * a safe, explicitly-scoped data object — no access to process.env, filesystem,
 * or network. LiquidJS parses templates to an AST (no eval/new Function).
 */

import { lazyRef, map } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import type { EmailTemplateFormat, EmailTemplateType } from "#lib/db/settings.ts";
import { getEmailTemplateSet } from "#lib/db/settings.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { isPaidEvent } from "#lib/types.ts";
import type { RegistrationEntry } from "#lib/webhook.ts";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
import { eventNames } from "#templates/email/shared.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { Liquid } from "liquidjs";

/** Create a configured Liquid engine with custom filters */
const createEngine = (): Liquid => {
  const engine = new Liquid({ strictVariables: false, strictFilters: true });

  engine.registerFilter("currency", (v: string | number) =>
    formatCurrency(v));

  engine.registerFilter("pluralize", (count: number, singular: string, plural: string) =>
    count === 1 ? singular : plural);

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
  event: {
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
  };
};

/** Data object passed to Liquid templates */
export type TemplateData = {
  entries: TemplateEntry[];
  event_names: string;
  attendee: TemplateEntry["attendee"];
  ticket_url: string;
  currency: string;
};

/** Build the data object exposed to Liquid templates */
export const buildTemplateData = (
  entries: RegistrationEntry[],
  currency: string,
  ticketUrl: string,
): TemplateData => {
  const templateEntries: TemplateEntry[] = map(
    ({ event, attendee }: RegistrationEntry): TemplateEntry => ({
      event: {
        name: event.name,
        slug: event.slug,
        is_paid: isPaidEvent(event),
      },
      attendee: {
        name: attendee.name,
        email: attendee.email,
        phone: attendee.phone,
        address: attendee.address,
        special_instructions: attendee.special_instructions,
        quantity: attendee.quantity,
        price_paid: attendee.price_paid,
        date: attendee.date,
      },
    }),
  )(entries);

  return {
    entries: templateEntries,
    event_names: eventNames(entries),
    attendee: templateEntries[0]!.attendee,
    ticket_url: ticketUrl,
    currency,
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
  const custom = await getEmailTemplateSet(type);

  const [subject, html, text] = await Promise.all([
    safeRender(custom.subject ?? defaults.subject, data, defaults.subject, type, "subject"),
    safeRender(custom.html ?? defaults.html, data, defaults.html, type, "html"),
    safeRender(custom.text ?? defaults.text, data, defaults.text, type, "text"),
  ]);

  return { subject, html, text };
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
      code: ErrorCode.EMAIL_SEND,
      detail: `template render error (${type}/${format}): ${error instanceof Error ? error.message : String(error)}`,
    });
    // If the custom template failed and it differs from the default, try the default
    if (template !== fallbackTemplate) {
      try {
        return await renderTemplate(fallbackTemplate, data);
      } catch {
        // Even default failed — return a minimal fallback
        return format === "subject" ? "Registration confirmation" : "";
      }
    }
    return format === "subject" ? "Registration confirmation" : "";
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
