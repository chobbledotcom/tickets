@story:servicing.the-work-coming-up
@owner:servicing @risk:low
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The organiser sees the service work coming up
  Service work holds places on a listing without anybody booking them, so the
  organiser needs to see what is still to come and what each piece of work is
  holding. Their dashboard carries the short version and the Servicing page
  the full one. Work whose day has passed is not coming up any more, so it
  drops off the dashboard rather than sitting there being scrolled past.

  @rule:servicing.the-servicing-page-names-what-is-held
  Rule: The Servicing page names each service event and what it holds
    Every service event is named with its date, the listings it holds places
    on, and how many places altogether. Each one links to itself, so the
    organiser can open it from the list.

    @case:servicing.the-servicing-list
    Scenario: The organiser opens the Servicing page
      Given a "Boiler Service" holds 2 places on Room A in 2099
      When the organiser opens the Servicing page
      Then the list names "Boiler Service" holding "Room A"
      And the list says 2 places are held
      And the list gives the day the work is due
      And there is one way into "Boiler Service"

  @rule:servicing.one-service-event-is-one-entry
  Rule: One service event is one entry, however many listings it holds
    A service event that holds places on two listings is still one piece of
    work, so it is listed once, naming both listings and the places
    altogether, rather than once for each listing it touches.

    @case:servicing.one-entry-on-the-servicing-page
    Scenario: A service event across two listings, on the Servicing page
      Given an "Annual Inspection" holds 2 places on Room A and 1 on Room B
      When the organiser opens the Servicing page
      Then the list names "Annual Inspection" holding "Room A, Room B"
      And the list says 3 places are held
      And "Annual Inspection" is listed once

    @case:servicing.one-entry-on-the-dashboard
    Scenario: A service event across two listings, on the dashboard
      Given an "Annual Inspection" holds 2 places on Room A and 1 on Room B
      When the organiser opens their dashboard
      Then the work coming up names "Annual Inspection" over 2 listings
      And there is one way into "Annual Inspection"

  @rule:servicing.work-whose-day-has-passed-is-not-coming-up
  Rule: Work whose day has passed is not coming up
    The dashboard is about what is still to be done, so a service event whose
    day has gone is left off it entirely rather than shown as finished.

    @case:servicing.past-work-drops-off
    Scenario: One service event has been and another is still to come
      Given a "Past Service" held places in 2000
      And a "Future Service" holds places in 2099
      When the organiser opens their dashboard
      Then the work coming up names "Future Service"
      And the work coming up does not name "Past Service"
      And there is no way into "Past Service"

  @rule:servicing.a-site-with-no-service-events-says-so
  Rule: A site with no service events says so
    A page that simply showed nothing would read as one that had failed to
    load, so it says there are none yet.

    @case:servicing.nothing-held-yet
    Scenario: The organiser opens the Servicing page before holding anything
      When the organiser opens the Servicing page
      Then the page says there are no service events yet
      And the page lists no service event

  @rule:servicing.a-read-only-site-offers-no-way-in
  Rule: A read-only site names the work but offers no way in
    Nothing can be changed on a site kept for reading, so the names stay
    readable and the links that would open them for editing are not there.

    @case:servicing.read-only-servicing-page
    Scenario: The organiser opens the Servicing page on a read-only site
      Given a "Boiler Service" holds 2 places on Room A in 2099
      And the site is kept for reading only
      When the organiser opens the Servicing page
      Then the list names "Boiler Service" holding "Room A"
      And there is no way into "Boiler Service"

    @case:servicing.read-only-dashboard
    Scenario: The organiser opens their dashboard on a read-only site
      Given a "Boiler Service" holds 2 places on Room A in 2099
      And the site is kept for reading only
      When the organiser opens their dashboard
      Then the work coming up names "Boiler Service"
      And there is no way into "Boiler Service"
