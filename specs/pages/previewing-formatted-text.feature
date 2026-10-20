@story:pages.previewing-formatted-text
@owner:pages @risk:low
@actor:editor
@edition:managed @edition:self-hosted
Feature: An editor previews formatted text
  The editor can preview markdown before saving it. A picture in the text
  shows in the preview exactly as it will once saved.

  @rule:pages.a-preview-shows-pictures-as-they-will-appear
  @surface:admin
  Rule: A preview shows pictures as they will appear
    A picture the editor uploaded shows with its own address. A picture that
    is not there keeps its describing words and shows no picture at all.

    @case:preview.a-picture-shows-with-its-own-address
    Scenario: The editor previews text with a picture in it
      Given an uploaded picture called "Hero"
      When the editor previews text with the picture in it
      Then the preview shows the "Hero" picture
      And the preview never shows the picture reference

    @case:preview.an-unknown-picture-keeps-its-describing-words
    Scenario: The editor previews text naming a picture that is not there
      When the editor previews text with a picture that was never uploaded
      Then the preview keeps the describing words
      And the preview shows no picture at all
