# Guide videos

A guide video shows one real admin journey. The recorder drives a throwaway
site with Playwright and keeps the frames Chrome paints. The three.js renderer
adds camera zooms and a focus vignette. FFmpeg writes the MP4.

The videos are silent. Add your own voiceover or captions after recording.

## Commands

Record one guide:

```bash
deno task guide:record create-a-listing
```

The command builds the site, signs the owner in, runs the guide's setup, records
the story, renders the frames, encodes the MP4, and writes the freshness
baseline. The video and poster land under `reports/guides/<slug>/`. The baseline
lands at `guides/<slug>/freshness.json`.

Useful options:

- `--allow-dirty` — build the video without replacing the committed baseline.
  Use this while the worktree holds uncommitted work.
- `--keep-session` — keep the screencast frames and `timeline.json`.
- `--keep-frames` — keep the rendered PNG sequence.
- `--from <directory>` — render an existing session again. This option skips
  the browser recording.
- `all` — record every guide in one run.

Check the guides against the latest Cucumber evidence:

```bash
deno task specs:evidence
deno task guide:check
deno task guide:check --guide create-a-listing
```

## How the recorder works

A storyboard is a list of real actions: open a page, click a link, type text one
character at a time, fill a date, tick a box, scroll, focus a rectangle, or wait.
The recorder runs the setup actions once. It then starts the screencast and runs
the story actions at human speed.

A focus action records the target rectangle and a zoom. The renderer turns that
rectangle into a camera position and a zoom, and dims the rest of the page. The
same screenshot shows a pointer that eases into each action.

The recorder never leaves the local site. It runs a temporary database with
fixed test keys and fake data. It blocks every request outside the loopback
address.

## Freshness

A guide names the Cucumber captures it uses as visual references. At record
time, `guide:record` stores two facts for each capture in
`guides/<slug>/freshness.json`:

- the SHA-256 digest of the image the video used.
- a 32 by 32 greyscale thumbnail of that image.

`guide:check` compares those facts with the images in
`reports/evidence/manifest.json`. An exact digest scores 100. Otherwise the
score is 75 percent page shape and 25 percent light and dark. Page shape uses a
normalised correlation, so a page that moved scores low even when both pages are
mostly white.

The scores are:

| Score | Status |
| ----- | ------ |
| 99 or more | fresh |
| 80 to 98 | aging |
| below 80 | stale |

The check is advisory. When a guide or one of its anchors falls below 80, the
check prints a warning and offers two choices: refresh the guide now, or leave it
for a separate branch. It exits 0. A malformed baseline or a missing capture
still fails, because the score cannot be computed.

The specification evidence workflow runs the check after it captures the
evidence. A warning appears in the workflow log.

## Add a guide

1. Add the Cucumber captures the guide will use to
   `scripts/specs/evidence/declarations.ts`. Use the `desktop` profile. When the
   page address is made while the story runs, the step must hand the address
   over with `leaveEvidencePage`.
2. Run `deno task specs:evidence` on a clean worktree.
3. Add a storyboard under `scripts/guides/storyboards/` and export it from
   `scripts/guides/storyboards/index.ts`. Name every evidence action with its
   capture id and Cucumber case id.
4. Run `deno task guide:record <slug>`.
5. Review the MP4 and the poster. Commit `guides/<slug>/freshness.json` with the
   storyboard. Do not commit `reports/`.

## Limits

- The score measures UI drift from the anchored captures. It does not read a
  voiceover or a caption.
- A selector is a real link address, form field name, or element id. A renamed
  selector fails the recording and names the action, so the video cannot quietly
  show the wrong page.
- Recording needs Chromium and ffmpeg. The devenv shell supplies both.
