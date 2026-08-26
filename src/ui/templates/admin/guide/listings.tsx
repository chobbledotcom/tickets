/**
 * Admin guide — Listings sections.
 */

/* jscpd:ignore-start -- imports */
import { formatCurrency } from "#shared/currency.ts";
import {
  custom,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";
/* jscpd:ignore-end */

/** The markdown text-formatting help section. Exported so the standalone
 * `/admin/formatting` help page (reachable by content roles, including editors
 * who can't open the staff-only full guide) renders the same content as the
 * guide's Text Formatting section. */
export const textFormattingSection: GuideSection = {
  entries: [
    faq("fields_support_formatting"),
    faq("what_formatting_can_i_use"),
    faq("how_does_the_visual_editor_work"),
  ],
  id: "text-formatting",
  titleKey: "text_formatting",
};

export const listingsSections = (): GuideSection[] => [
  {
    entries: [
      faq("standard_vs_daily_listings"),
      faq("combine_multiple_listings"),
      faq("what_are_groups"),
      faq("listing_in_multiple_groups"),
      faq("what_are_add_ons"),
      faq("bookable_alone"),
      faq("what_are_listing_defaults"),
      faq("listing_page_tabs"),
      faq("listing_date_and_location"),
      faq("max_tickets_per_purchase"),
      custom(
        "allow_pay_more",
        <p>
          When enabled, attendees can choose their own price instead of paying a
          fixed amount. The ticket price becomes a minimum. You can set a
          maximum price using the "Maximum Price" field — it must be at least{" "}
          {formatCurrency(100)} more than the ticket price. If the ticket price
          is zero, it becomes a pay-what-you-want listing where attendees can
          optionally enter any amount up to the configured maximum.
        </p>,
      ),
      faq("what_is_purchase_only_mode"),
      faq("registration_deadlines"),
      faq("embed_booking_form"),
      faq("manually_add_attendee"),
      faq("custom_redirect_after_booking"),
      faq("add_listing_image"),
      faq("add_file_attachment"),
      faq("listing_qr_code"),
      faq("duplicate_listing"),
      faq("deactivate_listing"),
      faq("non_transferable_tickets"),
      faq("edit_attendee"),
      faq("how_do_i_add_an_attendee_to"),
      faq("how_do_i_remove_an_attendee_from"),
      faq("how_do_i_delete_an_attendee"),
      faq("how_do_i_merge_duplicate_attendees"),
      faq("how_do_i_resend_a_confirmation_email"),
      faq("add_terms_and_conditions"),
    ],
    id: "listings",
    titleKey: "listings",
  },
  {
    entries: [
      faq("sell_time_slots"),
      faq("one_item_for_many_slots"),
      faq("sell_now_for_a_later_season"),
      faq("adult_and_child_prices"),
    ],
    id: "time-slots",
    titleKey: "time_slots",
  },
  {
    entries: [
      faq("group_vs_package"),
      faq("sell_group_as_package"),
      faq("package_member_pricing"),
      faq("hide_package_listings"),
      faq("package_capacity"),
    ],
    id: "packages",
    titleKey: "packages",
  },
  {
    entries: [
      faq("what_are_modifiers"),
      faq("how_modifier_values_work"),
      faq("modifier_value_precision"),
    ],
    id: "modifiers",
    titleKey: "modifiers",
  },
  {
    entries: [
      faq("what_are_custom_booking_questions"),
      faq("create_question"),
      faq("question_descriptions"),
      faq("add_question_to_listing"),
      faq("share_questions_between_listings"),
      faq("where_to_see_answers"),
    ],
    id: "questions",
    titleKey: "booking_questions",
  },
  {
    entries: [faq("facebook_403_error")],
    titleKey: "public_links",
  },
  {
    entries: [
      faq("what_is_public_site"),
      faq("hide_listing_from_public_list"),
      faq("edit_homepage_and_contact"),
      faq("what_are_site_pages"),
      faq("build_site_page"),
      faq("news_posts"),
    ],
    id: "public-site",
    titleKey: "public_site",
  },
  textFormattingSection,
];
