import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import {
  entityDeletePage,
  type TCall,
} from "#templates/admin/confirm-page.tsx";
import { DeactivationEffects } from "#templates/components/deactivation-effects.tsx";
import type { AdminSession, ListingWithCount } from "#types";

/** The parts of the confirm page each lifecycle action words differently. */
type ListingConfirmOptions = {
  title: string;
  action: string;
  buttonText: string;
  danger?: boolean;
  warning?: Child;
  prompt?: TCall;
  children?: Child;
};

/** A rendered confirm page for one listing, as the routes call it. */
type ListingConfirmPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
) => string;

/** Bind the shared listing confirm shell (dashboard nav, type-the-name label)
 *  to one action's options. */
const listingConfirmPageFrom = (
  buildOptions: (listing: ListingWithCount) => ListingConfirmOptions,
): ListingConfirmPage =>
  entityDeletePage((listing: ListingWithCount) => ({
    active: "/admin/",
    label: t("listings_table.listing_name"),
    name: listing.name,
    ...buildOptions(listing),
  }));

/** The actions the listing confirm pages share wording for: the URL segment,
 * the button key, and the title key all build from this one word. */
type ListingVerb = "delete" | "deactivate" | "reactivate";

/** Bind the shared confirm shell to one lifecycle verb: the action posts to
 * `/admin/listing/<id>/<verb>`, and the button and title read the verb's
 * catalog keys. */
const listingVerbPage =
  (verb: ListingVerb) =>
  (
    options: (
      listing: ListingWithCount,
    ) => Omit<ListingConfirmOptions, "action" | "buttonText" | "title">,
  ): ListingConfirmPage =>
    listingConfirmPageFrom((listing) => ({
      action: `/admin/listing/${listing.id}/${verb}`,
      buttonText: t(`listings_table.${verb}_listing`),
      title: listingTitle(`listings_table.${verb}_listing_title`, listing),
      ...options(listing),
    }));

const warningText = (children: Child): JSX.Element => (
  <p>
    <strong>{t("listings_table.warning")}:</strong> {children}
  </p>
);

const listingTitle = (key: string, listing: ListingWithCount): string =>
  t(key, { name: listing.name });

/** The "type the name to confirm" line, naming the listing being acted on. */
const confirmParagraph = (
  key: string,
  listing: ListingWithCount,
): JSX.Element => <p>{t(key, { name: listing.name })}</p>;

export const adminListingDeletePage: ListingConfirmPage = listingVerbPage(
  "delete",
)((listing) => ({
  prompt: {
    args: { name: listing.name },
    key: "listings_table.delete_confirmation_text",
  },
  warning: warningText(
    t("listings_table.delete_warning_text", {
      count: listing.attendee_count,
    }),
  ),
}));

export const adminDeactivateListingPage: ListingConfirmPage = listingVerbPage(
  "deactivate",
)((listing) => ({
  children: (
    <>
      <DeactivationEffects
        effect404={t("listings_table.deactivate_effect_404")}
        effectPayments={t("listings_table.deactivate_effect_reject_payments")}
        effectRegistrations={t(
          "listings_table.deactivate_effect_prevent_registrations",
        )}
        existingAttendeesNote={t(
          "listings_table.existing_attendees_not_affected",
        )}
      />
      {confirmParagraph("listings_table.deactivate_confirmation_text", listing)}
    </>
  ),
  warning: warningText(t("listings_table.deactivate_warning")),
}));

export const adminReactivateListingPage: ListingConfirmPage = listingVerbPage(
  "reactivate",
)((listing) => ({
  children: (
    <>
      <p>{t("listings_table.reactivate_will_make_available")}</p>
      <p>
        {t("listings_table.public_page_accessible_new_attendees_can_register")}
      </p>
      {confirmParagraph("listings_table.reactivate_confirmation_text", listing)}
    </>
  ),
  danger: false,
}));
