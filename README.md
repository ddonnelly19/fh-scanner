# FH scanner

## Tool run order

Install dependencies once with `npm install`. The sibling
[forzagarage](../forzagarage) repo must be checked out next to this one: matching
reads its `car-ids` map, and its `collection-sync` command does all site updates.

| Step | Command | Purpose / required input |
| --- | --- | --- |
| 1 | `npm run run` | Start with the game collection on its first page. Creates a new run, captures all pages, saves tiles, performs name OCR, and matches names to FH6 ordinals from car-ids. |
| 2 (optional) | `npm run match` | Re-match saved tile OCR after reviewing unresolved names and editing `car-name-mapping.json`. No capture or OCR is repeated. |
| 3 | `npm run ownership` | Classifies each saved tile as owned, unowned or unknown and writes `owned-cars.json`: the owned cars as FH6 ordinals. |
| 4 | in forzagarage: `npm run collection-sync -- <run>\owned-cars.json --site forzalabs` | Previews which owned cars map to the site. Add `--apply` to log in and add the missing cars. Sites: `forzalabs`, `forzagarage`, `kudosprime`. |

Before step 3, inspect `ordinal-review.txt` and resolve any car-name mappings
you want included. Before step 4, inspect `ownership-evidence.json` and
`owned-cars.json`: unknown ownership and unidentified cars are left out and
listed under `review`, so the list may be incomplete. The local dashboard
(`npm run review:web`) is the quickest way to fix both.

For the newest saved run, a typical session is:

```powershell
npm run run
# Review ordinal-review.txt and edit car-name-mapping.json if needed.
npm run match     # Optional: step 1 already performed matching.
npm run ownership
# Review ownership-evidence.json and owned-cars.json.
cd ..\forzagarage
npm run collection-sync -- "..\fh-scanner\screenshots\scan-YFrlNh\owned-cars.json" --site forzalabs
npm run collection-sync -- "..\fh-scanner\screenshots\scan-YFrlNh\owned-cars.json" --site forzalabs --apply
```

`match` and `ownership` select the newest `scan-*` directory by creation time
unless `--run-dir` is supplied. To keep both steps on a specific run, pin it:

```powershell
$run = ".\screenshots\scan-YFrlNh"
npm run match -- --run-dir "$run"
npm run ownership -- --run-dir "$run"
```

After changing mappings with `match`, rerun `ownership` (or use the dashboard)
so `owned-cars.json` is rewritten. If capture stops before tile OCR finishes,
matching and ownership require the missing tile/text inputs to be completed first.

For names-only export, stop after step 1 or 2; `ordinals.txt` is already
generated.

### Signing in to a cloud provider

```powershell
npm run capture:cloud -- geforce --login
```

Use `xbox` instead of `geforce` for Xbox Cloud. This opens the same dedicated Edge
profile the captures use, waits while you sign in and finish any verification,
then closes the browser so the session stays in the profile. Choose "stay signed
in" or "keep me signed in" if the site offers it: a login the site marks as
temporary is dropped when the browser closes. Nothing is typed for you and the
terminal never sees credentials, so you can do this through a remote desktop
(Chrome Remote Desktop, Jump Desktop) from a phone or tablet.

### Keeping the stream open between runs

Starting a cloud session takes a while, so `--keep-open` starts Edge on its own
and leaves the window, and the game stream in it, running after the run ends:

```
npm run capture:cloud -- geforce --pages --keep-open
```

Every later run finds that window by its local debugging port (9333 for
GeForce Now, 9334 for Xbox) and uses it as it is, with or without the flag, so
the game only needs to be on My Cars with the first car selected. Close the
window with Alt+F4 when you're done. While it is open, any program on this PC
can control that browser through the port, signed-in session included, so don't
leave it running unattended.

### Stream frames and stats

Both cloud players show the game as WebRTC video in the page. By default the
walk and page scan read each frame straight from that video, at the stream's
own resolution (for example 2560x1440), instead of screenshotting the window,
which is capped by the window's size. When no playing video is found the
capture falls back to a screenshot and says so; `--source screen` always uses
screenshots.

Before a run starts the terminal shows what the stream delivers, for example
`Stream: 2560x1440 at 60 fps, 28.4 Mbps, H264`, and the capture size. A page
scan also records the stream stats for every page in `garage-pages.json`
(`stream`), so a page that reads badly can be matched to a drop in resolution
or bitrate. Stream resolution itself is set in the provider's own settings and
is kept in the saved browser profile. On GeForce Now (Settings, Gameplay,
Streaming quality, Custom) pick a 16:9 resolution such as 2560x1440 and set
"Adjust for network conditions" to "No adjustment" or "Optimal quality":
"Optimal latency" drops the resolution on packet loss (992x620 was seen). A
stream under 1920 wide is scaled up to 1920 before reading, with a warning.

While waiting for a move to show and the screen to settle (checked every
100 ms), the page scan checks
small 1280-wide JPEG frames, which are several times quicker to grab than a
full PNG; the full-size frame is taken once per page. Each "Captured page" line
shows how long that page took and where the time went. Cards are read once
paging has finished, because OCR running alongside slowed paging from about
3.6 s to 6.4 s a page at 2560x1440; the stream is free again as soon as the
terminal says so. `--read-during` reads in the background while paging
instead, which ends the whole run sooner but keeps the stream busy longer.

### Choosing the screen

Captures open on the laptop's built-in screen by default, so a run works the
same when external monitors are unplugged. Pass `--display primary` for the
primary screen or `--display 2` for `\\.\DISPLAY2` (the numbers Windows uses);
without a built-in screen, `internal` falls back to the primary one. The
terminal prints which screen it chose.

Capture modes open Edge in kiosk mode, which fills the whole screen (normal full
screen left the page about 40 px short). Kiosk mode has no address bar or tabs;
the scanner closes it when the run ends, or press Alt+F4. A screen that isn't
16:9 adds black bars, which are cropped before anything is read: the built-in
3:2 screen gives a 1920x1080 game picture. `--login` opens a normal maximized
window instead.

Every capture mode (`--walk`, `--pages`, `--record` and the single capture) now
checks the browser's URL before each screenshot and key press. If the stream
tab has been sent to a provider sign-in page, the run stops with a message to
sign in again. A walk or paging run is saved as `interrupted` with that error.
The check only looks at known sign-in URLs (`login.nvidia.com`,
`login.live.com`, `login.microsoftonline.com` and Xbox's `/auth` route), so a
session that expires some other way, such as a stream that drops to an error
screen on the same page, is not detected.

Run `npm run capture:cloud -- geforce` (or `xbox`) to open a dedicated Edge
profile. Log in manually, launch the game, open **My Cars**, select a car,
and show the left-hand stats panel (press **L** to toggle ratings/details).
The extractor automatically recognizes either panel. Make the game fill the viewport at 16:9
without letterboxing or streaming overlays, then press Enter in the terminal.
The browser closes after capture; OCR runs locally.

To extract from an existing game-only screenshot without opening a browser:

```powershell
npm run capture:cloud -- geforce --image ".\screenshots\geforce-example.png"
```

Each capture creates a separate `screenshots\performance-*` directory with
`car.png` and `performance.json`. The observation includes the highlighted
tile's name/year/manufacturer, panel type, class/PI and drivetrain. Ratings
mode reads six ratings and tires; detail mode reads power, torque, weight,
front weight percentage and displacement as `{ value, unit }` measurements,
preserving displayed units without conversion. Fields not displayed in the
selected mode are null, not errors. Only the visible panel is captured per
run; the script does not automatically press L or merge separate captures.
The observation also includes
raw OCR text/confidence, timestamp and provider. The current-car banner is
not used to identify the selected car. Unreadable fields are null and listed
in `issues`; low-confidence OCR is also flagged. Ratings and detail numbers
are read by Tesseract's shape-based legacy engine and cross-checked by the
LSTM engine, which can misread a streamed 7 as 1; any disagreement is listed
in `issues` with both readings. Review-required results
exit with code 1 but retain evidence. Layout failures retain the screenshot
and report an error rather than generating a successful observation.

This initial extractor targets the supplied FH My Cars layout; other layouts
need calibration. It does not traverse the garage, identify duplicate garage
copies, read individual tuning settings, or infer upgrades. Observations are
snapshots of the selected build, not catalog attributes. Dedicated browser
profiles under `%LOCALAPPDATA%\fh-scanner\browser-profiles` contain login data;
do not share or commit them.

### Garage walk (ratings and details for every car)

```powershell
npm run capture:cloud -- geforce --walk
```

Use `xbox` instead of `geforce` for Xbox Cloud. Edge opens in kiosk mode, filling
the screen (see "Choosing the screen" below). Launch the game, open **My Cars**,
select the first (top-left) car, click the stream to focus it, hide overlays,
then press Enter. Don't touch the stream while the walk runs.

For each car the walk captures the visible stats panel, presses **L** (Toggle
Stats; P only toggles the tile icons), captures the other panel and merges
both into one record: identity, class/PI, drivetrain, tires, the six ratings
and the detail measurements. My Cars groups cars into manufacturer columns
that scroll horizontally, so the walk goes Down each column, then Right to the
next column, climbing Up to its top first if Right landed on a lower row. At
the bottom of a short column the game's Down jumps diagonally into a
neighbouring column, so the walk only presses Down when it sees a car tile
directly below the highlight, and stops (rather than revisiting cars) if Down
still leaves the column. It
stops when neither Down nor Right changes the highlighted tile. A move or
toggle that seems to have been dropped by the stream is retried once.

If the browser window isn't 16:9 (for example on a different monitor), the
stream adds black bars; captures are cropped to the centred 16:9 game area
before anything is saved or read. The walk and the page scan check the first
capture and stop straight away, before creating a run folder, if the game
still isn't 16:9 or no highlighted car is visible.

Navigation and the toggle check only compare images, so the walk saves each
car's screenshots and moves on (about 3 s per car) while OCR reads them in the
background, one car at a time and in walk order. OCR is slower than the walk,
so the console's "Captured car N" lines run ahead of the "Car N: ..." lines,
and the command finishes once every captured car has been read. You can leave
the stream as soon as the last car is captured.

Each `screenshots\garage-*` directory contains `car-NNNN-1.png`,
`car-NNNN-2.png` (and `-3` when a toggle was retried) and `garage.json`, which
is rewritten after every car, so an interrupted walk keeps the cars already
captured. Fields the panels disagree on (car, class/PI, drivetrain) are null
and listed in that car's `issues` rather than guessed. The command exits with
code 1 when any car needs review or the walk didn't complete.

Options: `--max-cars <n>` stops after n cars (useful for a quick test, for
example `--max-cars 5`), and `--settle-ms <100..10000>` sets how long to wait
after each key press for the stream to update (default 1200). Raise it if
captures show the previous car or a half-drawn panel.

The walk visits grid positions, so duplicate copies of the same car each get
their own record. It doesn't read tuning or upgrades yet.

### Garage pages (every card, one screenshot per screen)

```powershell
npm run capture:cloud -- geforce --pages
```

A faster survey of the whole garage than the walk: instead of opening each
car's stats, it screenshots each screen of the My Cars grid and reads every
card on it, giving each car's name, year, manufacturer, rarity, class/PI,
drivetrain and tires. It doesn't read ratings or detail measurements; use
`--walk` for those. Set up the stream as for the walk and select the first
(top-left) car before pressing Enter.

Right moves the highlight one column and the game scrolls the grid to keep it
leftmost, so after each screenshot paging presses Right once per fully
visible column (about four), landing on the column that was cut off at the
right edge. It stops when Right no longer changes the screen, capturing the
final screen if it shows columns not yet captured. A Right that seems to have
been dropped is retried once. As with the walk, cards are read in the
background from the saved screenshots while paging moves on.

Each `screenshots\pages-*` directory contains `page-NNN.png` and
`garage-pages.json`, rewritten after every page. Cars are listed by grid
column and row, counted from where paging started; a car seen on two pages is
kept once, and a conflicting second reading is listed in that car's `issues`.
Fields that couldn't be read are null and listed in `issues`, including:

- names cut off with an ellipsis on the card (the readable part is kept) and
  the highlighted card's name, which scrolls when it is long;
- drivetrain and tire icons that don't match a known icon. Icons are matched
  against small templates in `src\ocr\card-icons`, never guessed from a
  near match. Rebuild them after a walk that includes cars with other tires
  (for example off-road) or drivetrain icons:

  ```powershell
  node src\cli\card-icon-templates.ts            # every screenshots\garage-* walk
  node src\cli\card-icon-templates.ts .\screenshots\garage-abc123
  ```

  The walk's `garage.json` labels the highlighted card on each walk
  screenshot. Only the icon crops are written. Templates from 4K and 1920-wide
  captures sit side by side as numbered variants of the same label.

  A card with no tire icon is a car on its stock tires, recorded as
  `Stock Tires` without an issue. Rarity comes from the colour of the rarity
  bar, with the bar's text as a fallback and cross-check. The class comes from
  the PI when both OCR engines agree on it.

Each card is also tied to the car-ids list by its year, manufacturer and
name (`catalog` holds the car number and full name). A name cut off on the
card is matched by the part that is shown; when exactly one car fits, the
full name is known and the cut-off issue is dropped.

To check the card reader against walks, run
`node src\cli\validate-card-pages.ts .\screenshots\garage-abc123`. It reads
every card on each walk screenshot, matches cards to walked cars and prints
per-field accuracy and every mismatch.

After changing the card reader or its templates, re-read a finished page scan
without scanning again:

```powershell
node src\cli\reread-pages.ts .\screenshots\pages-abc123
```

It writes `garage-pages.reread.json` next to `garage-pages.json` (or the file
named by `--out`) and prints how many cards each kind of issue flags, before
and after.

Options: `--max-pages <n>` stops after n screens, and `--settle-ms` works as
for the walk. The command exits with code 1 when any car needs review or
paging didn't complete.

### Multi-screen cloud recording

```powershell
npm run capture:cloud -- geforce --record
```

Use `xbox` instead of `geforce` for Xbox Cloud. Launch the game manually,
click the stream to focus it, and press Enter in the terminal to save the
initial screen. Then enter commands, one at a time:

```text
key p
capture detail panel
key ArrowRight
wait 1500
capture next car
done
```

`key <Playwright key> [hold-ms]` sends a key (default 100 ms, maximum 5000 ms)
and waits 500 ms for the stream to react. Use lowercase `p` for the detail
toggle, `Enter`, `Escape`, `ArrowDown`, or combinations such as `Shift+Tab`.
`wait <ms>` adds a recorded delay (1..30000 ms). `capture [label]` saves a
viewport screenshot; `help` shows commands; `done` closes the browser.

Each `screenshots\recording-*` run contains numbered screenshots and an
atomically updated `recording.json` timeline with keys, hold/settle durations,
labels, timestamps and action status. Pending/failed actions are not claimed
as successful. A completed key action means Playwright sent input, not that
the game accepted it: verify the following screenshot and add waits as needed.
Manual browser/controller inputs are not recorded. Hard termination can leave
the session marked recording with a pending action; earlier saved files remain.
Do not enter credentials through recorded key commands. Browser input support
still needs verification in each provider's live session.

Recording is screen-agnostic: it does not run OCR, navigate automatically,
or combine cars. To extract a recorded My Cars screen, use the existing
`--image` mode with the numbered screenshot path. `--record` and `--image`
cannot be combined.

### Development validation

- `npm test`: run all Vitest tests; no capture, keyboard input or account updates.
- `npm run test:watch`: run tests in watch mode while developing.
- `npx tsc --noEmit`: check TypeScript types without generating output.
- `node src\cli\validate-card-pages.ts <garage directory>`: check the My Cars card reader against a garage walk (OCR only, no capture).

## Code organization

All application TypeScript lives under `src`; npm commands run the entrypoints
in `src\cli` directly. Tests remain under `test`.

```text
src\
  capture\       Windows capture, paging/end detection, tile extraction
  ocr\           Local Tesseract and ownership-label recognition
  collection\    Shared car-name parsing, normalization, matching and aliases
  catalogs\      Catalog types and the car-ids ordinal source
  workflows\     Matching/export, ownership inputs and the owned-cars list
  web\           Local saved-run dashboard
  cli\           Scanner, matching, ownership-review and dashboard commands
test\            Offline unit tests and local OCR smoke tests
```

The editable `car-name-mapping.json` remains in the project root.

### Updating tracker sites

fh-scanner stops at `owned-cars.json` and never contacts a tracker site. The
file is `{ "format": "fh-owned-cars", "version": 1, "cars": [{ "ordinal", "name",
"sources" }], "review": [...] }`. forzagarage's `collection-sync` package maps the
ordinals to each site's ids through car-ids and adds the missing cars: ForzaLabs
through its API with the saved login, KudosPrime and ForzaGarage through Edge.
See `collection-sync/README.md` in that repo for login, confirmation and audit
details. Earlier runs' `kudos-owned-plan.json`, `forzagarage-owned-plan.json`
and `<site>-car-mapping.json` files are no longer read; rerun `npm run ownership`
on those runs to get `owned-cars.json`.

### Ownership review (no account updates)

Review ownership using the saved tiles:

```powershell
npm run ownership
# Or select a particular run:
npm run ownership -- --run-dir ".\screenshots\scan-YFrlNh"
```

Without `--run-dir`, ownership review uses the newest `scan-*` folder under the
project's `screenshots` directory by creation time. The selected path is logged
before OCR starts.

This offline pass reads the run's saved `car-ordinals-source.json`, so run
matching first. Based on the confirmed collection-screen rule, a recognized
COMMON/RARE/EPIC/LEGENDARY label means owned, a DISCOVER/JAPAN placeholder means
unowned, and missing evidence is unknown (never assumed owned). OCR evidence is
saved in `ownership-evidence.json`. `owned-cars.json` lists each positively
owned, identified car once by ordinal, with the tiles it came from, plus review
reasons for unknown ownership or unidentified cars. Ownership is not inferred
from the names-only output.

### Local saved-run dashboard

Start the local interface for an existing run (matching/ownership inputs can
be generated from the dashboard if they are missing):

```powershell
node .\src\cli\review-web.ts --run-dir ".\screenshots\scan-YFrlNh"
# Or: npm.cmd run review:web -- --run-dir ".\screenshots\scan-YFrlNh"
```

Open `http://127.0.0.1:4173` (use `--port` to choose another port).

- **Load selection** switches between saved `scan-*` runs.
- **Match names to ordinals** updates the shared name mapping's suggestions and
  writes the matching outputs.
- **Run ownership OCR** processes existing tiles with progress in the job log.
  Both jobs run sequentially; inputs/selection are locked while a job is running.
- Review filters show unresolved owned cars, owned, unknown, unowned, all tiles
  or manually matched tiles. Each tile displays its image and original OCR.
- **Save ownership correction** requires inspecting the tile and checking the
  verification box. Corrections are recorded in `ownership-overrides.json`;
  the original OCR evidence is retained and corrections survive later OCR
  passes. **Restore OCR classification** removes a correction.
- **Save match & next** pins the tile to a car by ordinal. Suggested cars are
  not automatically accepted; search all cars when years or branding differ.
- **Rewrite owned-cars.json** rebuilds the list from evidence, ownership
  corrections and matches, without OCR.

Each save records the tile's ordinal in the run's `car-matches.json` and
rewrites `owned-cars.json` without rerunning OCR. Matches apply to individual
tiles, do not edit the shared `car-name-mapping.json`, and are also honored by
later ownership review. Unknown/unowned tiles are left out until you explicitly
verify and save an owned correction. **Remove manual match** restores normal
matching; **Skip for now** saves nothing.

The server binds only to loopback; screenshots and OCR stay local and nothing
is sent to a tracker site. Stale dashboard edits are rejected. Use **Reload
local files** after external edits to evidence, catalogs or mappings. Ctrl+C
stops the server. New capture/keyboard automation stays in the terminal
(`npm run run`).

### Collection capture details

Install dependencies with `npm install`, then run `npm run run` with
the streaming window open and positioned on the first page of cars.
The scanner captures pages of up to 15 cars until it detects the end. After capturing page 1, it
presses Down 5 times to reach page 2, then Down 3 times between subsequent
pages. Key presses are spaced 200 ms apart, with a 1300 ms settling delay
before the next capture.

End detection compares the model/year text bands in the five-column,
three-row grid, excluding the animated background and selection borders.
Minor compression differences are tolerated (per card: mean grayscale
difference at most 3/255 and at most 1% of pixels differing by more than 25).
An unchanged page triggers one additional three-Down confirmation batch;
if it is still unchanged, capture ends. Duplicate end probes are not saved
or sent to OCR. A partial final page is retained when its names differ.
This assumes the collection layout shown in the saved screenshots; keep
the collection visible and do not switch windows during capture.
Two ignored navigation batches can look like the end, so check the last
saved page if the stream stalls. A 1000-page safety limit raises an error
without starting OCR rather than claiming an incomplete scan succeeded.

The scanner runs in four phases:

1. Capture and save every page as cropped, full-color PNGs.
2. Split each saved page into 15 full-color car tiles (five columns by three
   rows), preserving the full pages. All tiles are saved before OCR starts.
3. Initialize OCR and process each tile's model/year/manufacturer text area,
   using grayscale, normalization, thresholding, enlargement, and white padding. Raw OCR text is
   printed and saved alongside each tile.
4. Match OCR text against the FH6 ordinals in the sibling forzagarage project's
   `car-ids` map (`..\forzagarage\car-ids\data\car-ids.json`, installed as
   `@forzagarage/car-ids`; rebuild it there with `npm run build:data`),
   then export deduplicated matched catalog names.

No OCR runs during capture, and no keyboard input is sent during splitting
or OCR. Screenshots are always saved.

```powershell
node .\src\cli\scanner.ts
node .\src\cli\scanner.ts --screenshots-dir "C:\captures\forza"
# Through the existing npm script:
npm run run
```

The default output directory is `.\screenshots`. Each run creates a unique
`scan-...` subdirectory containing `page-001.png`, `page-002.png`, etc.,
so previous runs are not overwritten. The output path is logged.
The old `--save-screenshots` flag is still accepted but is no longer needed.
All screenshots remain available if OCR initialization or recognition fails.
Tiles are saved under `tiles` in the run directory, named
`page-001-r1-c1.png` through `page-001-r3-c5.png`, with matching `.txt` OCR
results. Tiles are processed left-to-right, top-to-bottom, in page order.
The fixed grid coordinates match the collection layout used for end detection.
All 15 slots are retained even on a partial final page; empty or overlapping
car slots are not automatically filtered. OCR matching reads the model line(s)
followed by a year/manufacturer line; ownership status is not inferred.

### Ordinal output

Each run directory contains:

- `ordinals.txt`: one confirmed catalog car name per line, deduplicated and
  sorted alphabetically (including the leading year). Despite the filename,
  it contains names, not ordinal numbers. No headers or unresolved candidates
  are included. Ordinal numbers remain in `ordinal-matches.txt`.
- `ordinal-review.txt`: unmatched, ambiguous, or unparseable tiles, their OCR
  text, and up to five suggested catalog entries for manual review.
- `ordinal-matches.txt`: confirmed source identifier, catalog name, and source tile
  for every match, including repeated captured cars.
  The identifier is the FH6 ordinal from car-ids.
- `car-ordinals-source.json`: the car-ids name→ordinal snapshot used for matching.
  A name car-ids gives two ordinals (e.g. `2025 GR GT Prototype`) is left out
  and goes to review.

Existing manual selections always take precedence. When matching, a selection that names
an older spelling (the old HDR gist or KudosPrime's upper case) is moved to the
car-ids name for the same car; one car-ids doesn't know goes back to review. Fuzzy suggestions
always require manual selection.

Automatic matches require the complete year/manufacturer/model to agree after
case, accents, spacing, and punctuation normalization. Similar names, different
years, Abarth/Fiat branding differences, and catalog internal filenames are not
guessed. For example, `2007 Alfa Romeo 8C Competizione` is reviewed, not
automatically mapped to the catalog's `2008` entry. Candidate suggestions are
never added to the ordinal list. Review warnings are printed even when export
succeeds; the ordinal file may therefore be incomplete until those are resolved.

### Manual car name mapping

The shared `car-name-mapping.json` in the project root is used by both the
scanner and `npm run match`. It is populated with unique parsed captured names:
confirmed matches point to their exact catalog names, while unresolved names
have a `selected: null` value and up to five ranked candidate names. Unparseable OCR stays in the review file; correct its tile
text file first so it can become a mapping entry.

To resolve a car, copy the correct candidate name into `selected`. For example:

```json
{
  "1964 Aston Martin DB5": {
    "selected": null,
    "candidates": [
      "1964 Aston Martin DB5 Vantage"
    ]
  }
}
```

Candidates are filtered to the captured car's year, then ranked by text
similarity. They are suggestions only, not verified
identities. An empty candidate list means no sufficiently similar named
catalog entries were found. Set `selected` only after verifying the car.
You can select any exact catalog name, even if it is not in the suggestions.
Simple string resolutions are also still supported:

```json
{
  "1980 Abarth Fiat 131": "1980 Fiat 131 Abarth Stradale"
}
```

This resolution produces ordinal `1124`. The Fiat example is pre-resolved.
Use the full captured name exactly as shown in the mapping's key.
Manual mappings take precedence over automatic matching. Existing values,
including selections and entries absent from the current run, are preserved;
unresolved candidate lists encountered in the current run are refreshed with
same-year suggestions. Missing captured names are appended. Legacy `null` entries encountered
in a run are upgraded to choice objects with ranked candidates, leaving
`selected` null.
Invalid JSON or a catalog name not present in the selected catalog raises an
error instead of ignoring the edit. A catalog snapshot must contain all
resolved targets in the mapping.

After editing, rerun matching to regenerate the ordinal/review files without
recapturing or performing OCR. To use a separate mapping, pass
`--mapping "C:\captures\custom-mapping.json"` to `npm run match`.

Process an existing run's OCR files without recapturing or rerunning OCR:

```powershell
npm run match
# Or select a particular run:
npm run match -- --run-dir ".\screenshots\scan-YFrlNh"
# Reproducible matching with a previously saved snapshot:
npm run match -- --run-dir ".\screenshots\scan-YFrlNh" --catalog ".\screenshots\scan-YFrlNh\car-ordinals-source.json"
```

Matching reads car-ids locally by default; `--catalog` replays a saved
`car-ordinals-source.json` instead.
Matching and ownership review default to the newest `scan-*` folder
by creation time under the project's `screenshots` directory and log the
selected path. An explicit `--run-dir` overrides discovery. Missing input
files fail on that selected run; commands never silently choose an older run.
The scanner always creates a new run under the same default screenshots
directory; `--screenshots-dir` overrides its output location.
The npm `run` and `match` commands enable Node's `--use-system-ca` option
to trust installed Windows certificate authorities without disabling TLS
verification. For direct execution on networks with an enterprise CA, use
`node --use-system-ca .\src\cli\scanner.ts`.
OCR text and screenshots stay local and are never uploaded. Catalog failures
are reported explicitly; existing capture/OCR files are retained. Rerunning
matching replaces generated matching files and snapshots but not the tile text.

English OCR language data is installed through `@tesseract.js-data/eng`.
The scanner uses the packaged LSTM data and local Tesseract engine; it does
not download language data from a CDN or use a working-directory OCR cache.
Dependency installation requires registry access. Ordinal matching reads car-ids
locally, so the forzagarage repo must be checked out next to this one.

If OCR initialization fails, the scanner reports the error and exits with
code 1. It terminates the OCR worker when leaving the processing phase.
Capture, screenshot-saving, or navigation failures stop the capture phase
and prevent OCR from starting. Already saved images are retained.

On Windows, physical window bounds are read through DWM using the installed
Windows PowerShell. This avoids nut-js clipping secondary-monitor windows
to the primary display or returning DPI-virtualized dimensions. Each cycle
refreshes the bounds, captures the monitor containing the largest part of
the window, and crops its visible portion relative to that monitor.
Restore minimized windows before scanning. A window spanning monitors is
scanned only on the monitor containing its largest visible portion.

Run `npm test` for ordinal matching, ownership and owned-list building,
navigation, options, screenshot-saving, car-tile, monitor/crop tests,
and an OCR recognition smoke test without
capturing the desktop or sending keyboard input. Run `npx tsc --noEmit` to
type-check.

Tests use Vitest in the Node environment with isolated process workers.
Run `npm run test:watch` for watch mode, or
`npm test -- test\car-ordinals.test.ts` to run a single test file.
Configuration lives in `src\vitest.config.ts`; all `test\*.test.ts` files
are discovered automatically. OCR smoke tests have a 30-second timeout.
