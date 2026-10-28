@story:settings.tax-settings
@owner:settings @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The organiser chooses how tax applies to listed prices
  The settings page offers three ways to tax a booking: no tax, tax added to
  listed prices, or tax already included in listed prices, with a rate of up
  to two decimal places. A rate the site cannot store is refused and nothing
  is saved.

  @rule:settings.the-organiser-chooses-how-tax-applies-to-listed-prices
  @surface:admin
  Rule: The organiser chooses how tax applies to listed prices
    The saved choice shows on the settings page, so the organiser can see what
    is in force before they make a booking.

    @case:settings.setting-tax-added-to-prices
    Scenario: The organiser sets tax added to listed prices
      When the organiser sets 20 percent tax added to listed prices
      Then the tax settings show tax added to listed prices at 20.00 percent

    @case:settings.setting-tax-included-in-prices
    Scenario: The organiser sets listed prices that include tax
      When the organiser sets 17.51 percent tax included in listed prices
      Then the tax settings show listed prices include tax at 17.51 percent

  @rule:settings.a-rate-the-site-cannot-store-is-refused
  @surface:admin
  Rule: A rate the site cannot store is refused
    A rate too large to hold is turned away with the rate's own error, and the
    site keeps collecting no tax.

    @case:settings.refusing-a-rate-the-site-cannot-store
    Scenario: The organiser types a tax rate the site cannot store
      When the organiser sets a tax rate the site cannot store
      Then the organiser is told the tax rate is not accepted
      And the site still collects no tax
