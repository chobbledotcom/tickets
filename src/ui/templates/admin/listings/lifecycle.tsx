import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { ConfirmPage, type TCall } from "#templates/admin/confirm-page.tsx";

const listingConfirmPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error: string | undefined,
  opts: {
    title: string;
    action: string;
    buttonText: string;
    danger?: boolean;
    warning?: Child;
    prompt?: TCall;
    children?: Child;
  },
): string =>
  ConfirmPage({
    active: "/admin/",
    error,
    label: t("listings_table.listing_name"),
    name: listing.name,
    session,
    ...opts,
  });

type ListingConfirmOptions = Parameters<typeof listingConfirmPage>[3];

/** A rendered confirm page for one listing, as the routes call it. */
type ListingConfirmPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
) => string;

const listingConfirmPageFrom =
  (
    buildOptions: (listing: ListingWithCount) => ListingConfirmOptions,
  ): ListingConfirmPage =>
  (listing, session, error) =>
    listingConfirmPage(listing, session, error, buildOptions(listing));

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

export const adminListingDeletePage: ListingConfirmPage =
  listingConfirmPageFrom((listing) => ({
    action: `/admin/listing/${listing.id}/delete`,
    buttonText: t("listings_table.delete_listing"),
    prompt: {
      args: { name: listing.name },
      key: "listings_table.delete_confirmation_text",
    },
    title: listingTitle("listings_table.delete_listing_title", listing),
    warning: warningText(
      t("listings_table.delete_warning_text", {
        count: listing.attendee_count,
      }),
    ),
  }));

export const adminDeactivateListingPage: ListingConfirmPage =
  listingConfirmPageFrom((listing) => ({
    action: `/admin/listing/${listing.id}/deactivate`,
    buttonText: t("listings_table.deactivate_listing"),
    children: (
      <>
        <ul>
          <li>{t("listings_table.deactivate_effect_404")}</li>
          <li>{t("listings_table.deactivate_effect_prevent_registrations")}</li>
          <li>{t("listings_table.deactivate_effect_reject_payments")}</li>
        </ul>
        <p>{t("listings_table.existing_attendees_not_affected")}</p>
        {confirmParagraph(
          "listings_table.deactivate_confirmation_text",
          listing,
        )}
      </>
    ),
    title: listingTitle("listings_table.deactivate_listing_title", listing),
    warning: warningText(t("listings_table.deactivate_warning")),
  }));

export const adminReactivateListingPage: ListingConfirmPage =
  listingConfirmPageFrom((listing) => ({
    action: `/admin/listing/${listing.id}/reactivate`,
    buttonText: t("listings_table.reactivate_listing"),
    children: (
      <>
        <p>{t("listings_table.reactivate_will_make_available")}</p>
        <p>
          {t(
            "listings_table.public_page_accessible_new_attendees_can_register",
          )}
        </p>
        {confirmParagraph(
          "listings_table.reactivate_confirmation_text",
          listing,
        )}
      </>
    ),
    danger: false,
    title: listingTitle("listings_table.reactivate_listing_title", listing),
  }));
