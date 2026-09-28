import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-28_site_renewal_recovery_facts",
  "Capture what a booking paid in site months when it is booked, and what a built site's renewal provisioning has confirmed, so a failed provider push recovers the buyer's original term instead of whatever the plan states today",
  {
    columns: {
      built_sites: ["pending_renewal_cutoff", "renewal_url_confirmed"],
      listing_attendees: ["site_months"],
    },
  },
  async ({ getDb }) => {
    // Every booking line takes the term its plan stated at migration time.
    // Rows booked after this deploy are stamped at write; these backfilled
    // rows only need a term that matches what their owners were told.
    await getDb().execute(
      `UPDATE listing_attendees
          SET site_months = COALESCE(
                (SELECT listing.initial_site_months
                        * listing_attendees.quantity
                   FROM listings AS listing
                  WHERE listing.id = listing_attendees.listing_id),
                0)`,
    );
  },
);
