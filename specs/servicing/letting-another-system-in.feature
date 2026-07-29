@story:servicing.letting-another-system-in
@owner:servicing @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner lets another system work on their behalf
  An owner can hand a key to something that is not a person — their own
  website, a spreadsheet, a booking screen in a shop — so it can read and
  change what they sell without anybody signing in. The key stands in for the
  owner, so it is shown once, kept by name afterwards, and can be taken back at
  any moment.

  @rule:servicing.a-key-is-shown-once-and-then-only-named
  Rule: A key is shown once, and after that only its name
    The site shows the key the moment it is made, with a word to say it will
    not be shown again. From then on the owner sees only the name they gave it.
    Anyone who reads the list later learns what keys exist, and nothing they
    could use.

    @case:api-keys.made-and-shown-once
    Scenario: The owner makes a key
      Given the owner is looking at their keys
      When the owner makes a key called Shopfront
      Then the owner is shown the key itself, and told to copy it now
      And the list of keys names Shopfront
      And the list of keys never shows the key itself

  @rule:servicing.a-key-stands-in-for-signing-in
  Rule: A key stands in for signing in
    A request carrying the key is served as the owner. One carrying nothing, or
    something that is not a key, is turned away — and turned away as
    unauthorised, not as a missing page, so the caller knows what to fix.

    @case:api-keys.a-key-opens-the-api
    Scenario: Another system asks for what the site sells
      Given the site sells a Pottery
      And the owner has a key called Shopfront
      When Shopfront asks the site what it sells
      Then Shopfront is told about the Pottery

    @case:api-keys.a-key-can-change-things-too
    Scenario: Another system puts something new on sale
      Given the site sells a Pottery
      And the owner has a key called Shopfront
      When Shopfront puts a Kiln on sale
      Then the site sells the Kiln
      And Shopfront is told about the Kiln

    Scenario Outline: A request the site cannot place is refused
      Given the site sells a Pottery
      When something asks the site what it sells, <carrying>
      Then the request is refused as unauthorised

      Examples:
        | case_id                      | carrying             |
        | api-keys.refused-no-key      | carrying nothing     |
        | api-keys.refused-wrong-key   | carrying a made-up key |

  @rule:servicing.a-key-never-opens-the-pages-a-person-uses
  Rule: A key never opens the pages a person uses
    A key is for one system talking to another. It does not sign anybody in, so
    the pages an owner reads and clicks stay shut to it — including the page
    where keys themselves are made. Otherwise a key that leaked would hand over
    the whole site, not just the part it was meant for.

    Scenario Outline: A key is turned away from an owner's own pages
      Given the owner has a key called Shopfront
      When Shopfront asks for the owner's "<page>" page
      Then Shopfront is not let in

      Examples:
        | case_id                        | page     |
        | api-keys.pages-shut-keys       | keys     |
        | api-keys.pages-shut-settings   | settings |

  @rule:servicing.a-key-can-be-taken-back
  Rule: A key can be taken back
    Taking a key away is deliberate: the owner types its name to confirm, and a
    name that does not match changes nothing. Once it is gone the key stops
    working straight away, which is the whole point of being able to take it
    back.

    @case:api-keys.taken-back
    Scenario: The owner takes a key back
      Given the site sells a Pottery
      And the owner has a key called Shopfront
      And Shopfront is told about the Pottery
      When the owner takes back the key called Shopfront
      Then the list of keys is empty
      And Shopfront is refused as unauthorised

    @case:api-keys.wrong-name-changes-nothing
    Scenario: The owner types the wrong name
      Given the site sells a Pottery
      And the owner has a key called Shopfront
      When the owner tries to take back Shopfront by typing Shopfont
      Then the owner is told the name does not match
      And the list of keys names Shopfront
      And Shopfront is told about the Pottery
