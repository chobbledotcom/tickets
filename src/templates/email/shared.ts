/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import type { RegistrationEntry } from "#lib/webhook.ts";
export type { RegistrationEntry };

export type EmailContent = { subject: string; html: string; text: string };

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

export const eventNames = (entries: RegistrationEntry[]): string =>
  listFormat.format(map(({ event }: RegistrationEntry) => event.name)(entries));
