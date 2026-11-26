# Guide videos

A guide video shows one real admin journey. The recorder drives a throwaway
site with Playwright and keeps the frames Chrome paints. The three.js renderer
adds camera zooms and a focus vignette, and FFmpeg writes the MP4. The renderer
is a build-time tool only: the deployed app holds the URL of the finished video
and never ships three.js.

The videos are silent. Add your own voiceover or captions after recording.

## Commands

Record one guide into `reports/guides/<slug>/` for review:

```bash
deno task guide:record create-a-listing
```

The command builds the site, signs the owner in, runs the guide's setup, records
the story, renders the frames, encodes the MP4, and writes the freshness
baseline. The video lands under `reports/guides/<slug>/guide.mp4`. The baseline
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

Publish the videos to the Bunny CDN:

```bash
deno task specs:evidence
deno task guide:publish
```

The deploy workflows run both commands before they build the edge script: the
evidence capture produces the screenshot hashes that decide whether a guide
needs recording again.

### Preview locally

`deno task dev` reports each `reports/guides/<slug>/guide.mp4` at
`/guide-videos/<slug>`. The create listing form then shows the camera link and
the modal plays the recorded file. Restart the dev server after you record a
guide.

An explicit `GUIDE_VIDEOS` value wins over that scan. Use it to preview an
object on the CDN:

```bash
GUIDE_VIDEOS='{"create-a-listing":{"video":"https://cdn.example.com/guides/create-a-listing-abc.mp4"}}' \
  deno task dev
```

The camera link appears beside the create-listing heading and the modal plays
the named file. The edge build replaces the local override with the map it
bakes in.

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

Recording and rendering both work at two device pixels per CSS pixel
(`GUIDE_DEVICE_SCALE_FACTOR`): a 1280 by 720 viewport becomes a 2560 by 1440
video. Chrome's screencast sends frames at the browser window's device
resolution, so the recorder launches Chromium with a forced device scale factor
and a matching window size. The page still lays out at 1280 by 720, and the
screencast arrives at 2560 by 1440 with real detail. The renderer's canvas draws
at the same ratio, so a focus zoom up to 2x samples the recorded frame at one
texture pixel per video pixel instead of enlarging a 720p image.

## CDN videos

`guide:publish` renders one MP4 per guide and uploads it under a name made from
the hash of its bytes:

```text
guides/create-a-listing-0123456789abcdef.mp4
```

Two sites on different releases therefore point at different objects, and a
later recording can never overwrite the file an older site links to.

Beside the video the command writes a pointer at
`guides/pointers/<slug>-<inputs-hash>.json`. The inputs hash covers the guide's
anchored screenshot hashes, the storyboard, and `GUIDE_PIPELINE_VERSION`. A
publish run reads the pointer first:

- pointer present, its video still served — nothing is recorded or uploaded. The
  app gets the existing URL.
- pointer absent or unreadable — the guide is recorded, rendered, encoded, and
  uploaded. Then the pointer is written.

A change to the pipeline (the scale factor, the encoder settings) bumps
`GUIDE_PIPELINE_VERSION`, so old pointers stop matching and the next run
re-renders. The upload verifies every object's bytes and content type. A failed
publish stops the deploy, so the app never links to a missing video.

The deploy build bakes a JSON map into `GUIDE_VIDEOS`. The create listing form
shows a small video camera link beside its title when the map names that guide.
The link opens the MP4 in the admin modal, muted and autoplaying. Without a map
the page shows no link.

A publish run without the Bunny storage secrets does not render or upload
anything: there is no origin for the edge script to name. The workflow
returns an empty map instead, and every guide link stays hidden.

The parent page needs `media-src` for the CDN origin. The security header adds
it when the map names a video.

## Workflow

`publish-guides.yml` runs only for a push to `main` (a merge) and for a manual
dispatch from the Actions tab. Every deploy workflow calls it before building
the edge script and passes the returned map to the build action.

The job captures the specification evidence first, because the render decision
reads the screenshot hashes from `reports/evidence/manifest.json`. The whole run
is therefore only as expensive as the evidence capture, unless a guide really
did change.

Three.js is never bundled into the deployed script: the build asserts that
`WebGLRenderer` and `THREE.` appear nowhere in the output.

## Freshness

A guide names the Cucumber captures it uses as visual references. At record
time, `guide:record` writes one edge hash for each capture to
`guides/<slug>/freshness.json`, with the commit that it recorded. The
storyboard holds the guide title and the case of each capture, so the baseline
does not repeat them.

To make an edge hash, the recorder shrinks the image to a 16 by 16 greyscale
grid. Each of the 240 bits records whether one cell is clearly brighter than the
cell to its right. The hash is 60 hex characters.

`guide:check` hashes the images in `reports/evidence/manifest.json` again. The
score is the share of edges that both hashes hold: the edges in both, divided by
the edges in either. A colour change or a small text change keeps the score
high. A block that moves puts its edges in other cells, so the score falls,
even when both pages are mostly white. A sideways move gives a lower score than
a downward move of the same size.

The baseline must name the same captures as the storyboard. If the storyboard
adds or removes a capture, the check fails and asks you to record the guide
again.

The publish decision is stricter than the check: an anchor that differs at all
changes the inputs hash and records the guide again.

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
5. Review the MP4. Commit `guides/<slug>/freshness.json` with the storyboard. Do
   not commit `reports/`.

## Limits

- The score measures UI drift from the anchored captures. It does not read a
  voiceover or a caption.
- A selector is a real link address, form field name, or element id. A renamed
  selector fails the recording and names the action, so the video cannot quietly
  show the wrong page.
- Recording needs Chromium and ffmpeg. The devenv shell supplies both.
- The uploaded MP4 is about 2560 by 1440 for a 63-second guide, so a modal
  download is several megabytes. The player streams with `preload="metadata"`
  and faststart, so playback starts before the whole file arrives.
