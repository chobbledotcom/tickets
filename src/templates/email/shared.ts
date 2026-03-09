/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import type { RegistrationEntry } from "#lib/webhook.ts";
export type { RegistrationEntry };

export type EmailContent = { subject: string; html: string; text: string };

export const eventNames = (entries: RegistrationEntry[]): string =>
  map(({ event }: RegistrationEntry) => event.name)(entries).join(" and ");
