/**
 * Admin guide — Listings sections.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { Faq, Q, Section } from "#templates/admin/guide/components.tsx";

export const Listings = (): JSX.Element => (
  <>
    <Section title={t("guide.sections.listings")}>
      <Faq id="standard_vs_daily_listings" />

      <Faq id="combine_multiple_listings" />

      <Faq id="what_are_groups" />

      <Faq id="listing_date_and_location" />

      <Faq id="max_tickets_per_purchase" />

      <Q q={t("guide.q.allow_pay_more")}>
        <p>
          When enabled, attendees can choose their own price instead of paying a
          fixed amount. The ticket price becomes a minimum. You can set a
          maximum price using the "Maximum Price" field — it must be at least{" "}
          {formatCurrency(100)} more than the ticket price. If the ticket price
          is zero, it becomes a pay-what-you-want listing where attendees can
          optionally enter any amount up to the configured maximum.
        </p>
      </Q>

      <Faq id="what_is_purchase_only_mode" />

      <Faq id="registration_deadlines" />

      <Faq id="embed_booking_form" />

      <Faq id="manually_add_attendee" />

      <Faq id="custom_redirect_after_booking" />

      <Faq id="add_listing_image" />

      <Faq id="add_file_attachment" />

      <Faq id="listing_qr_code" />

      <Faq id="duplicate_listing" />

      <Faq id="deactivate_listing" />

      <Faq id="non_transferable_tickets" />

      <Faq id="edit_attendee" />

      <Faq id="how_do_i_add_an_attendee_to" />

      <Faq id="how_do_i_remove_an_attendee_from" />

      <Faq id="how_do_i_delete_an_attendee" />

      <Faq id="how_do_i_merge_duplicate_attendees" />

      <Faq id="how_do_i_resend_a_confirmation_email" />

      <Faq id="add_terms_and_conditions" />
    </Section>

    <Section id="modifiers" title={t("guide.sections.modifiers")}>
      <Faq id="what_are_modifiers" />

      <Faq id="how_modifier_values_work" />
    </Section>

    <Section id="questions" title={t("guide.sections.booking_questions")}>
      <Faq id="what_are_custom_booking_questions" />

      <Faq id="create_question" />

      <Faq id="add_question_to_listing" />

      <Faq id="share_questions_between_listings" />

      <Faq id="where_to_see_answers" />
    </Section>

    <Section title={t("guide.sections.public_links")}>
      <Faq id="facebook_403_error" />
    </Section>

    <Section title={t("guide.sections.public_site")}>
      <Faq id="what_is_public_site" />

      <Faq id="hide_listing_from_public_list" />

      <Faq id="edit_homepage_and_contact" />
    </Section>

    <Section id="text-formatting" title={t("guide.sections.text_formatting")}>
      <Faq id="fields_support_formatting" />

      <Faq id="what_formatting_can_i_use" />
    </Section>
  </>
);
