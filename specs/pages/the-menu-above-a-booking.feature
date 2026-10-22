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
      And the Visit page is marked as the place they are
      And the Kayak is marked as the place they are
      And the Walk is offered beside it

    @case:menu-above-a-booking.marks-every-page-the-booking-sits-inside
    Scenario: A visitor opens a booking from a page inside another page
      Given the public site is on
      And the site sells a Kayak
      And the site sells a Walk
      And the owner has written a page called Visit at "visit"
      And the owner has written a page called Extras at "extras"
      And the owner has put the Extras page inside the Visit page
      And the owner has put the Kayak and the Walk on the Extras page
      When a customer opens the booking page the Kayak is sold from
      Then the menu shows the Visit page's own list
      And the menu shows the Extras page's own list
      And the Visit page is marked as the place they are
      And the Extras page is marked as the place they are
      And the Kayak is marked as the place they are
      And the Walk is offered beside it

  @rule:pages.a-booking-of-a-group-marks-the-group
  Rule: A booking of a group marks the group in the menu
    When a visitor books a whole group the owner has put on one of their
    pages, the menu marks the group and the pages it sits on. The things
    inside the group are not places of their own on that page, so the menu
    marks none of them.

    @case:menu-above-a-booking.marks-the-group-being-booked
    Scenario: A visitor opens the booking page of a group on a page
      Given the public site is on
      And a Weekend group holding a Tent at 40.00 and a Breakfast at 10.00
      And the organiser sells the Weekend as a bundle, with the Tent at 25.00 and the Breakfast left blank
      And the owner has written a page called Visit at "visit"
      And the owner has put the group called Weekend on the Visit page
      And the site sells a Map
      And the owner has put the Map on the Visit page
      When a customer opens the Weekend group's booking page
      Then the menu shows the Visit page's own list
      And the Visit page is marked as the place they are
      And the Weekend group is marked as the place they are
      And the Map is offered beside it
      And the Tent is not marked as the place they are
      And the Breakfast is not marked as the place they are

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
      Then the booking form offers the Kayak and the Walk
      And the menu still offers the Visit page
      And the menu shows no Visit page's own list
      And no menu entry is marked as the place they are
