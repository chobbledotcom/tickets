@story:settings.turning-features-on-and-off
@owner:settings @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The owner turns features on and off
  A site arrives with its features off, and the owner turns on the ones they
  want. Each feature has a page of its own that says what it does before it
  offers the choice, so nobody has to guess what they are turning on. Site
  reaches further than the rest: it decides whether the public site is
  published at all. A feature the site already holds saved items for reads as
  enabled, and stays that way until those items are removed.

  @rule:settings.every-feature-is-listed-with-its-status
  @surface:admin
  Rule: Every feature is listed with whether it is enabled
    The settings page names each feature, says Enabled or Disabled beside it,
    and links to the page that explains it. A feature the site already holds
    saved items for reads as Enabled without anybody choosing it, because
    those items are already there to look after.

    @case:features.the-list-of-features
    Scenario: The owner looks at their features
      When the owner looks at their settings
      Then every feature is listed as Disabled
      And every feature links to the page that explains it

    @case:features.saved-items-read-as-enabled
    Scenario: A feature the site holds items for reads as enabled
      Given the site already holds a saved Modifiers item
      When the owner looks at their settings
      Then "Modifiers" is listed as Enabled

  @rule:settings.a-feature-says-what-it-does-first
  @surface:admin
  Rule: A feature says what it does before it offers the choice
    Every feature's own page carries its name and a sentence saying what
    turning it on will do, above the choice itself.

    Scenario Outline: The owner reads what a feature does
      When the owner opens the "<feature>" feature
      Then they are told what "<feature>" does
      And they are offered the choice

      Examples:
        | case_id                     | feature    |
        | features.says-site          | Site       |
        | features.says-attributes    | Attributes |
        | features.says-questions     | Questions  |
        | features.says-modifiers     | Modifiers  |
        | features.says-logistics     | Logistics  |
        | features.says-api-keys      | API keys   |
        | features.says-servicing     | Servicing  |
        | features.says-money         | Money      |

  @rule:settings.the-owner-enables-and-disables-a-feature
  @surface:admin
  Rule: The owner enables a feature and can disable it again
    The choice is kept, the owner is told which feature changed and how, and
    the change is written to the activity log so it is not a silent one.

    @case:features.enabling-a-feature
    Scenario: The owner enables a feature
      When the owner enables "Money"
      Then the owner is told "Money enabled."
      And the activity log says "Money enabled."
      And the "Money" page comes back offering Yes

    @case:features.disabling-a-feature
    Scenario: The owner disables a feature again
      Given the owner enables "Money"
      When the owner disables "Money"
      Then the owner is told "Money disabled."
      And the "Money" page comes back offering No

  @rule:settings.site-decides-whether-the-public-site-is-published
  @surface:public
  Rule: Site decides whether the public site is published
    Site is not only an entry in the admin menu. While it is off there is no
    public site to read, and a visitor who opens the front page is sent to the
    sign-in page instead. Turning it on puts the site in front of them.

    @case:features.no-public-site-while-site-is-off
    Scenario: A visitor arrives while Site is off
      Then a visitor opening the front page is sent to sign in

    @case:features.enabling-site-publishes-the-public-site
    Scenario: The owner publishes the public site
      When the owner enables "Site"
      Then a visitor can read the front page

  @rule:settings.a-feature-in-use-cannot-be-disabled
  @surface:admin
  Rule: A feature the site holds saved items for cannot be disabled
    The feature's page says it is in use and says what to do about it, and it
    offers no choice at all, so there is nothing for the owner to send.

    @case:features.a-feature-in-use-offers-no-choice
    Scenario: The owner opens a feature that is in use
      Given the site already holds a saved Modifiers item
      When the owner opens the "Modifiers" feature
      Then they are told "Modifiers" is in use
      And they are told to remove its saved items first
      And they are offered no choice

  @rule:settings.a-read-only-site-offers-no-choice
  @surface:admin
  Rule: A read-only site says where a feature stands but offers no choice
    A site kept for reading only changes nothing, so the page says whether the
    feature is enabled and stops there.

    @case:features.read-only-says-where-a-feature-stands
    Scenario: The owner opens a feature on a read-only site
      Given the site is kept for reading only
      When the owner opens the "Modifiers" feature
      Then they are told "Modifiers" is Disabled
      And they are offered no choice
