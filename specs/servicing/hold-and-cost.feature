@story:servicing.hold-and-cost
@owner:servicing @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser holds and costs a service event
  A service event reserves listing capacity without creating a customer ticket.
  The organiser can see, duplicate, delete, and cost the hold.

  @rule:servicing.hold-is-visible-and-private
  Rule: A service hold appears to the organiser but not to the customer
    The hold reserves capacity and never becomes a public listing or ticket.

    @case:servicing.hold-on-dashboard
    Scenario: The organiser sees a new hold on the dashboard
      Given an organiser has created a Boiler Service hold on Room A
      Then the admin dashboard shows the Boiler Service hold
      And the public site does not show Boiler Service

  @rule:servicing.hold-can-be-duplicated
  Rule: A duplicated hold is an independent copy
    Duplicating a service event creates a second event with the same bookings.

    @case:servicing.duplicate-hold
    Scenario: The organiser duplicates an annual inspection
      Given an organiser has created an Annual Inspection hold on Annual Room
      When the organiser duplicates the service event
      Then the admin dashboard shows two Annual Inspection holds

  @rule:servicing.hold-can-be-deleted
  Rule: Deleting a hold frees the reserved capacity
    The hold and its booking rows are removed.

    @case:servicing.delete-hold
    Scenario: The organiser deletes a Boiler Service hold
      Given an organiser has created a Boiler Service hold on Room A
      When the organiser deletes the service event
      Then the admin dashboard no longer shows Boiler Service
      And the held listing has its full capacity restored

  @rule:servicing.hold-can-be-costed
  Rule: The organiser can record a cost against a hold
    A cost is money spent on the service, recorded against one of the held listings.

    @case:servicing.record-cost
    Scenario: The organiser records a cost for a Boiler Service
      Given an organiser has created a Boiler Service hold on Room A
      When the organiser records a cost of 90.00 for Boiler Service
      Then the service event page shows the recorded cost
