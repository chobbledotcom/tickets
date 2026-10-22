@story:attendees.unsent-notifications
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The organiser sees which bookings still owe a notification
  When a booking is made the site sends an email and fires the listing's
  webhooks. A send that the other side never accepted stays marked as owed, so
  the organiser can see it and send it again. The organiser sees the notice
  beside the booking on the attendee list and on the booking's own page, and
  the dashboard counts the attendees still owed a send and leads to the list.

  @rule:attendees.a-send-that-never-got-accepted-stays-visible
  @surface:admin
  Rule: A send that never got accepted stays visible beside its booking
    The notice sits beside the booking it belongs to, so a booking whose sends
    all went out is never mixed up with one that still owes a send.

    @case:unsent.email-notice-on-the-list
    Scenario: The list shows a booking whose email never went out
      Given Ada has a ticket for the Ceilidh whose email never went out
      And Bea has a ticket for the Quiz whose sends all went out
      When the organiser opens the attendee list
      Then the list says Ada's email never went out
      And the list says nothing about Bea's sends

    @case:unsent.webhook-notice-on-the-list
    Scenario: The list shows a booking whose webhooks never went out
      Given Ada has a ticket for the Ceilidh whose webhooks never went out
      And Bea has a ticket for the Quiz whose sends all went out
      When the organiser opens the attendee list
      Then the list says Ada's webhooks never went out
      And the list says nothing about Bea's sends

    @case:unsent.both-notices-on-the-list
    Scenario: The list shows a booking that owes both sends
      Given Ada has a ticket for the Ceilidh whose email and webhooks never went out
      And Bea has a ticket for the Quiz whose sends all went out
      When the organiser opens the attendee list
      Then the list says Ada's email and webhooks never went out
      And the list says nothing about Bea's sends

    @case:unsent.email-notice-on-the-attendees-own-page
    Scenario: The booking's own page shows the owed email
      Given Ada has a ticket for the Ceilidh whose email never went out
      When the organiser opens Ada's own page from the attendee list
      Then Ada's own page says their email never went out

    @case:unsent.webhook-notice-on-the-attendees-own-page
    Scenario: The booking's own page shows the owed webhooks
      Given Ada has a ticket for the Ceilidh whose webhooks never went out
      When the organiser opens Ada's own page from the attendee list
      Then Ada's own page says their webhooks never went out

    @case:unsent.a-notified-booking-shows-no-notice-on-its-page
    Scenario: A booking whose sends went out shows no notice
      Given Ada has a ticket for the Ceilidh whose sends all went out
      When the organiser opens Ada's own page from the attendee list
      Then Ada's own page says nothing about their sends

    @case:unsent.email-notice-on-the-resend-page
    Scenario: The re-send page shows the owed email
      Given Ada has a ticket for the Ceilidh whose email never went out
      When the organiser opens Ada's own page from the attendee list
      And the organiser opens the re-send notification page from the Actions tab
      Then the re-send page says Ada's email never went out beside their name

    @case:unsent.webhook-notice-on-the-resend-page
    Scenario: The re-send page shows the owed webhooks
      Given Ada has a ticket for the Ceilidh whose webhooks never went out
      When the organiser opens Ada's own page from the attendee list
      And the organiser opens the re-send notification page from the Actions tab
      Then the re-send page says Ada's webhooks never went out beside their name

    @case:unsent.a-notified-booking-shows-no-notice-on-the-resend-page
    Scenario: A booking whose sends went out shows no notice on the re-send page
      Given Ada has a ticket for the Ceilidh whose sends all went out
      When the organiser opens Ada's own page from the attendee list
      And the organiser opens the re-send notification page from the Actions tab
      Then the re-send page says nothing about Ada's sends

    @case:unsent.no-booked-listing-collects-an-email
    Scenario: The email notice goes when no booked listing collects an email
      Given Ada has a ticket for the Ceilidh whose email never went out
      When the organiser opens the attendee list
      Then the list says Ada's email never went out
      When the Ceilidh stops collecting an email
      And the organiser opens the attendee list
      Then the list says nothing about Ada's sends

    @case:unsent.stopped-email-keeps-the-webhook-notice
    Scenario: The webhook notice stays when the listing stops collecting an email
      Given Ada has a ticket for the Ceilidh whose email and webhooks never went out
      And the Ceilidh has stopped collecting an email
      When the organiser opens the attendee list
      Then the list says Ada's webhooks never went out
      And the list says nothing about Ada's email

    @case:unsent.a-notice-belongs-to-its-own-listing
    Scenario: A booking shows the email notice only for its own listing
      Given Ada has tickets for the Ceilidh and the Quiz whose email never went out
      When the organiser opens the attendee list
      Then the list says Ada's email never went out
      When the organiser opens the Ceilidh's attendee list
      Then the list says Ada's email never went out
      When the Ceilidh stops collecting an email
      And the organiser opens the Ceilidh's attendee list
      Then the list says nothing about Ada's email
      And the organiser opens the Quiz's attendee list
      Then the list says Ada's email never went out

    @case:unsent.the-notice-keeps-its-own-words-apart-from-the-name
    Scenario: The notice reads as its own words beside the name
      Given Ada has a ticket for the Ceilidh whose email never went out
      When the organiser opens the attendee list
      Then the list shows Ada's name and the email notice as separate words

  @rule:attendees.the-dashboard-counts-the-bookings-still-owed-a-send
  @surface:admin
  Rule: The dashboard counts the attendees still owed a send
    The count leads to the attendee list. An attendee is counted once however
    many of their sends are owed. An attendee whose sends all went out adds
    nothing. When an attendee's listing stops collecting an email, the owed
    email no longer counts. An owed webhook still counts, and the attendee
    stays in the count. An attendee whose last listing is deleted is not on
    the list any more, so their owed sends add nothing. With nothing owed the
    dashboard shows no count at all.

    @case:unsent.dashboard-counts-each-owed-booking-once
    Scenario: The dashboard counts each owed attendee once
      Given Ada has a ticket for the Ceilidh whose email never went out
      And Bea has a ticket for the Quiz whose webhooks never went out
      And Cara has a ticket for the Gala whose email and webhooks never went out
      And Dan has a ticket for the Feast whose sends all went out
      When the organiser opens the dashboard
      Then the dashboard counts 3 attendees with unsent notifications

    @case:unsent.the-count-leads-to-the-attendee-list
    Scenario: The count leads to the attendee list
      Given Ada has a ticket for the Ceilidh whose email never went out
      When the organiser follows the count to the attendee list
      Then the list says Ada's email never went out

    @case:unsent.settled-bookings-do-not-count
    Scenario: A settled attendee and a lost email listing add nothing to the count
      Given Ada has a ticket for the Ceilidh whose email never went out
      And Bea has a ticket for the Quiz whose sends all went out
      And Cara has a ticket for the Gala whose email never went out
      When the Gala stops collecting an email
      And the organiser opens the dashboard
      Then the dashboard counts 1 attendee with unsent notifications

    @case:unsent.stopped-email-keeps-the-webhook-count
    Scenario: The webhook keeps the count when the listing stops collecting an email
      Given Ada has a ticket for the Ceilidh whose email and webhooks never went out
      And the Ceilidh has stopped collecting an email
      When the organiser opens the dashboard
      Then the dashboard counts 1 attendee with unsent notifications

    @case:unsent.a-deleted-listing-drops-the-count
    Scenario: The count drops when the booking's listing is deleted
      Given Ada has a ticket for the Ceilidh whose webhooks never went out
      And the Ceilidh is deleted
      When the organiser opens the dashboard
      Then the dashboard says nothing about unsent notifications

    @case:unsent.nothing-owed-hides-the-count
    Scenario: A site with nothing owed shows no count
      Given Ada has a ticket for the Ceilidh whose sends all went out
      When the organiser opens the dashboard
      Then the dashboard says nothing about unsent notifications
