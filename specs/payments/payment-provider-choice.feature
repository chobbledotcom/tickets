@story:payments.provider-choice
@owner:payments @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser chooses a payment provider
  An organiser can switch between supported payment providers.
  A saved provider setup remains available when selected again.

  @rule:payments.saved-provider-can-be-selected
  Rule: A saved test setup remains available after switching providers
    Selecting a provider makes it active without removing its saved key.

    @case:payments.select-saved-stripe
    Scenario: The organiser switches back to a saved Stripe test setup
      Given a Stripe test key is saved while Square takes payments
      When the organiser changes the payment provider to Stripe
      Then the payment settings show Stripe selected with its saved key in test mode
