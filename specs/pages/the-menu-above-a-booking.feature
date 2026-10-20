@story:pages.the-menu-above-a-booking
@owner:pages @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
@surface:public
Feature: The menu above a booking
  A booking page shows the site's menu above the form, so a visitor can reach
  the rest of the site. The page whose list they are booking from is the place
  they are, so the menu marks their own entry. A booking of several things at
  once belongs to no single entry, so the menu marks nothing.

  @rule:pages.a-booking-marks-its-own-entry
  Rule: A booking marks its own entry in the menu
    When a visitor books something the owner has put on one of their pages,
    the menu shows that page's own list and marks the thing being booked, so
    the visitor can see where they are and step sideways to the rest of the
    page.

    @case:menu-above-a-booking.marks-the-entry-being-booked
    Scenario: A visitor opens a booking from a page's own list
      Given the public site is on
      And the site sells a Kayak
      And the site sells a Walk
      And the owner has written a page called Visit at "visit"
      And the owner has put the Kayak and the Walk on the Visit page
      When a customer opens the booking page the Kayak is sold from
      Then the menu shows the Visit page's own list
      And the Kayak is marked as the place they are
      And the Walk is offered beside it

  @rule:pages.a-booking-of-several-things-marks-nothing
  Rule: A booking of several things marks nothing in the menu
    Several things booked together belong to no single page entry, so the
    menu above such a booking shows no page's own list and marks nothing.

    @case:menu-above-a-booking.a-combo-marks-nothing
    Scenario: A visitor opens a booking for two things at once
      Given the public site is on
      And the site sells a Kayak
      And the site sells a Walk
      And the owner has written a page called Visit at "visit"
      And the owner has put the Kayak and the Walk on the Visit page
      When a customer opens one booking for the Kayak and the Walk together
      Then the menu shows no Visit page's own list
      And no menu entry is marked as the place they are
