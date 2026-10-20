@story:pages.keeping-a-page-off-the-menus
@owner:pages @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner keeps a page off the menus
  Not every page is for everybody. A page can be written but not ready for the
  menus, or meant only for the people who have its link. The owner ticks
  Hidden on the page's editor, and the page stays at its address while the
  menus stop pointing the way to it.

  @rule:pages.a-page-off-the-menus-is-still-there
  @surface:public
  Rule: A page off the menus is still there
    Keeping a page off the menus is not taking it down. The menus stop
    offering the page, and anybody who has its address can still read it.

    @case:site-pages.off-the-menus-still-readable
    Scenario: The owner keeps a page off the menus
      Given the owner has written a page called Directions at "how-to-find-us"
      When the owner keeps Directions off the menus
      Then no menu offers Directions
      And a visitor reading "how-to-find-us" is shown Directions

  @rule:pages.the-editor-remembers-what-is-off-the-menus
  Rule: The editor remembers what is off the menus
    Ticking Hidden is a choice the site keeps. The editor opens showing the
    box ticked, and it comes back clear once the owner puts the page on the
    menus again.

    @case:site-pages.editor-shows-the-page-off-the-menus
    Scenario: The editor shows the page is off the menus
      Given the owner has written a page called Directions at "how-to-find-us"
      When the owner keeps Directions off the menus
      Then the editor for Directions opens with the Hidden box ticked

    @case:site-pages.editor-shows-the-page-back-on-the-menus
    Scenario: The owner puts a page back on the menus
      Given the owner has written a page called Directions at "how-to-find-us"
      And the owner has kept Directions off the menus
      When the owner puts Directions back on the menus
      Then the editor for Directions opens with the Hidden box clear
      And a menu offers Directions
