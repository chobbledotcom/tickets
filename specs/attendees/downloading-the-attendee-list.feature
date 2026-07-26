@story:attendees.downloading-the-attendee-list
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser downloads the list of people booked in
  An organiser can download a listing's bookings as a spreadsheet to print or
  hand to staff on the door. For a listing booked by the day, the date column
  has to name the days each booking actually holds — the days staff will see
  that person, not the longest stay the listing allows.

  @rule:attendees.the-download-names-the-days-each-booking-holds
  @surface:admin
  Rule: The date column names the days each booking holds
    A stay of several days is written as a range from its first day to its last.
    A booking of one day is written as that day on its own.

    @case:download.a-stay-shows-its-first-and-last-day
    Scenario: A three-day stay is downloaded
      Given a Cabin that is booked 3 days at a time, with room for 5 places a day
      And a customer booked a Cabin stay starting in 10 days
      When the organiser downloads the Cabin list
      Then the list shows that stay running from day 10 to day 12

    @case:download.a-one-day-booking-shows-one-day
    Scenario: A one-day booking is downloaded
      Given a Cabin that is booked 1 day at a time, with room for 5 places a day
      And a customer booked a Cabin stay starting in 10 days
      When the organiser downloads the Cabin list
      Then the list shows that booking on day 10 alone

  @rule:attendees.the-download-shows-the-length-the-customer-chose
  @surface:admin
  Rule: A stay the customer sized shows the length they chose
    Some listings let the customer pick how many days they want. The download
    must show what they picked, never the longest stay the listing allows.

    @case:download.the-chosen-length-not-the-maximum
    Scenario: A customer chose two days out of a possible five
      Given a Retreat where customers pick up to 5 days themselves
      And a customer booked a 2-day Retreat stay starting in 10 days
      When the organiser downloads the Retreat list
      Then the list shows that stay running from day 10 to day 11
      And the list never shows the stay running to day 14
