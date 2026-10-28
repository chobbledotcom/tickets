@story:attendees.applying-tax-to-a-booking
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An explicit save applies the current tax setting to a booking
  A booking keeps the tax facts it was made under. Changing the Tax setting
  alone never rewrites a booking's money. An organiser who saves an attendee
  applies the current setting to that booking: the price recorded at booking
  is reassessed, the customer's balance changes, and no money is taken or
  returned.

  @rule:attendees.changing-tax-settings-alone-changes-nothing
  @surface:admin
  Rule: Changing the Tax setting alone changes no booking
    The tax account stays empty and the customer still owes nothing until an
    attendee is explicitly saved.

    @case:attendees.changing-tax-settings-alone
    Scenario: The organiser changes the Tax setting and saves nothing
      Given a customer paid 45.00 for a Concert place
      When the organiser sets 20 percent value added tax added to listed prices
      Then no value added tax was recorded or refunded
      And the customer owes nothing

  @rule:attendees.saving-a-booking-applies-the-current-tax-setting
  @surface:admin
  Rule: Saving a booking applies the current Tax setting
    The saved booking carries the newly-assessed tax and balance, the organiser
    is told the change, and no payment provider is asked to move money.

    @case:attendees.saving-applies-the-current-tax-setting
    Scenario: The organiser saves a booking after changing the Tax setting
      Given a customer paid 45.00 for a Concert place
      And the organiser sets 20 percent value added tax added to listed prices
      When the organiser saves the Concert booking
      Then the booking now carries 9.00 of value added tax and the customer owes 9.00
      And the organiser is told the tax change was applied
      And no money was taken or returned
