/** Whether the site can offer a listing template right now. */

import { settings } from "#db/settings.ts";
import { saleProviderOrNull } from "#shared/config.ts";
import type {
  ListingTemplate,
  TemplateRequirement,
} from "#shared/listing-templates.ts";

/** A subscription also needs Stripe, because only Stripe charges a plan. */
const REQUIREMENT_MET: Record<TemplateRequirement, () => boolean> = {
  logistics: () => settings.features.logistics,
  subscriptions: () =>
    settings.features.subscriptions && saleProviderOrNull() === "stripe",
};

/** The feature the site must turn on before it can offer this template.
 *  Null when the template needs nothing, or the site already offers it. */
export const unmetRequirementOrNull = (
  template: ListingTemplate,
): TemplateRequirement | null =>
  template.requires !== null && !REQUIREMENT_MET[template.requires]()
    ? template.requires
    : null;
