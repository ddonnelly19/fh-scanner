# FH scanner

## Tool run order

Install dependencies once with `npm install`, then follow this order:

| Step | Command | Purpose / required input |
| --- | --- | --- |
| 1 | `npm run run` | Start with the game collection on its first page. Creates a new run, captures all pages, saves tiles, performs name OCR, and matches against HDR, KudosPrime and ForzaGarage catalogs automatically. |
| 2 (optional) | `npm run match` | Re-match saved tile OCR after reviewing unresolved names and editing `car-name-mapping.json`. No capture or OCR is repeated. Skip this if step 1's matches need no changes. |
| 3 | `npm run ownership` | Uses saved tile images, OCR text, catalog snapshots and current mapping to classify ownership and generate the selected site's owned-car plan. No site updates. |
| 4 | `npm run sync` | Preview the owned-car plan. Requires step 3. No browser login or account updates. |
| 5 (optional) | `npm run sync -- --apply` | After reviewing evidence and the preview, use Edge and type the requested confirmation to apply the selected site's owned-car plan. |

Before step 3, inspect `ordinal-review.txt` and resolve any car-name mappings
you want included. Before step 5, inspect `ownership-evidence.json` and the selected site's
owned-plan file: unknown ownership and unresolved site identities
are excluded, so the plan may be incomplete. Sync does not generate a missing
plan or run ownership OCR for you.

For the newest saved run, a typical session is:

```powershell
npm run run
# Review ordinal-review.txt and edit car-name-mapping.json if needed.
npm run match     # Optional: step 1 already performed matching.
npm run ownership
# Review ownership-evidence.json and the selected site's owned-plan file.
npm run sync
# Only after approving the preview:
npm run sync -- --apply
```

`match`, `ownership` and `sync` independently select the newest `scan-*`
directory by creation time unless `--run-dir` is supplied. To keep all steps
on a specific run, especially if another capture is created in between, pin
the same directory for each command:

```powershell
$run = ".\screenshots\scan-YFrlNh"
npm run match -- --run-dir "$run"
npm run ownership -- --run-dir "$run" --site kudosprime
npm run sync -- --run-dir "$run" --site kudosprime
npm run sync -- --run-dir "$run" --site kudosprime --apply
```

If you already have a complete saved run, skip capture and start at step 2
(if mappings need changes) or step 3. After changing mappings or refreshing
catalogs with `match`, rerun `ownership` and preview again before applying:
an existing owned plan is not automatically refreshed. If capture stops before
tile OCR finishes, matching and ownership require the missing tile/text inputs
to be completed first.

For names-only export, stop after step 1 or 2; `ordinals.txt` is already
generated. Ownership and sync are needed only to create and apply an owned-car
plan.

### Development tools (independent of the scan workflow)

- `npm test`: run all Vitest tests; no capture, keyboard input or account updates.
- `npm run test:watch`: run tests in watch mode while developing.
- `npx tsc --noEmit`: check TypeScript types without generating output.

## Code organization and site integrations

All application TypeScript lives under `src`; npm commands run the entrypoints
in `src\cli` directly. Tests remain under `test`. Root script wrappers have
been removed; use the npm commands or the direct paths shown below.

```text
src\
  capture\       Windows capture, paging/end detection, tile extraction
  ocr\           Local Tesseract and ownership-label recognition
  collection\    Shared car-name parsing, normalization, matching and aliases
  catalogs\      Catalog types, loading, and HDR ordinal source
  workflows\     Catalog merging and matching/export orchestration
  sites\
    kudosprime\  KudosPrime catalog parser, endpoint and response validation
    forzagarage\ ForzaGarage catalog parser and local tracker adapter
    types.ts     Site adapter contract and site-specific garage IDs
    registry.ts  Supported site adapters
    garage-plan.ts  Verified-owned filtering and site-bound plan validation
    apply-plan.ts  Sequential updates, audit persistence and failure handling
    browser-sync.ts  Edge session and explicit user confirmation
  cli\           Scanner, matching, ownership-review and sync commands
test\            Offline unit tests and local OCR smoke tests
```

The editable `car-name-mapping.json` remains in the project root. Saved runs,
catalog snapshot filenames, names-only output and existing commands are
unchanged. Catalog entries now carry `siteIds`, keyed by adapter ID, separately
from Forza `ordinal` values. IDs are never assumed interchangeable across sites.
Generated garage plans include a `site` tag; sync rejects a plan targeting a
different adapter. Old untagged KudosPrime plans are still accepted only by
the KudosPrime adapter.

Select the target explicitly when reviewing or syncing:

```powershell
npm run ownership -- --run-dir ".\screenshots\scan-YFrlNh" --site kudosprime
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh" --site kudosprime
# Or use ForzaGarage:
npm run ownership -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
```

Omitting `--site` keeps KudosPrime as the default. Unknown/unsupported sites
fail explicitly; they do not silently use KudosPrime.

### Adding another site

ForzaGarage is implemented as a local-only tracker adapter. Forza LabsGG and
FHStats remain future integrations; their catalogs, supported game versions,
login requirements, APIs and automation policies must be verified before
implementing writes.

1. Add a folder under `src\sites` containing that site's catalog parser/loader
   and adapter, following [the adapter contract](src/sites/types.ts).
2. Give it a unique adapter ID, catalog snapshot and plan/result filenames.
   Parse catalog data into `{ name, siteIds: { [adapterId]: id } }`; keep
   site-specific ID validation in the adapter.
3. Implement its login destination, readiness checks and `addOwned` operation.
   A successful operation must be positively acknowledged by that site's
   response/readback, not just an HTTP 200. Never infer another site's API
   from KudosPrime's request format.
4. Register it in [the site registry](src/sites/registry.ts). The matching
   workflow consumes registered catalogs; ownership planning resolves only
   exact names for the selected site's IDs. Ambiguity requires review.
5. Add catalog, request/response, site-ID isolation and failure tests before
   enabling updates.

The shared browser/sync runner handles preview separation, typed confirmation,
sequential additions, per-adapter delays, audit results and stopping on failure.
ForzaGarage checks are made through its tracker UI and confirmed in browser
storage; a shareable collection URL is saved after applying the plan. Its
progress is local to each browser, so load an existing share link into the
temporary Edge session first to preserve that starting collection. Opening the
resulting share link in another browser requires choosing “Load this collection”,
which replaces that browser's current tracker selection. Capture and OCR do
not depend on any site's authentication or update endpoint.
No credentials, OAuth codes, HAR replay or persistent login profiles belong in
adapters.

### Ownership review (no account updates)

Before syncing any garage, review ownership using the saved tiles:

```powershell
npm run ownership
# Or select a particular run:
npm run ownership -- --run-dir ".\screenshots\scan-YFrlNh"
```

Without `--run-dir`, ownership review uses the same newest-run selection as
sync: the newest `scan-*` folder under the project's `screenshots` directory
by creation time. The selected path is logged before OCR starts. Use
`--run-dir` for older runs or custom screenshot locations.

This offline pass uses all available saved catalog snapshots to validate the
shared name mapping, but only the selected site's IDs enter its plan. Its
snapshot is required; if missing, refresh the run's catalogs with matching.
Based on the confirmed
collection-screen rule, a recognized COMMON/RARE/EPIC/LEGENDARY label means
owned, a DISCOVER/JAPAN placeholder means unowned, and missing evidence is
unknown (never assumed owned). OCR evidence is saved in
`ownership-evidence.json`. The selected adapter's plan file contains
deduplicated site IDs (tagged with its site ID) for positively owned, exactly
matched cars and review reasons for uncertain ownership or missing site
mappings. Review the evidence and plan before any sync. This command never
updates a site and does not accept or store authentication cookies. Ownership
is not inferred from the names-only output.

### Browser login and garage sync

The authentication capture shows Google OAuth via KudosPrime's HybridAuth.
Log in interactively rather than replaying OAuth codes or copying cookies.
HAR captures can contain credentials/tokens: do not share or commit them
and invalidate exposed sessions. HAR files are excluded by `.gitignore`;
the sync tool does not read them.

First run ownership review and inspect `ownership-evidence.json` and
`kudos-owned-plan.json`. Unknown ownership and cars without an exact site ID
are excluded. If needed, update the name mapping and regenerate the plan.
Preview the reviewed plan without logging in or sending requests:

```powershell
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh"
```

With no `--run-dir`, `npm run sync` selects the newest `scan-*` directory
under the project's `screenshots` folder by directory creation time and logs
the selected path. Editing an older run does not make it the newest run.
If the selected run has no ownership plan, sync stops with the exact
`npm run ownership` command to generate it. It never falls back to an older
plan or assumes matched names are owned. Review the generated evidence and
plan before rerunning sync. For a custom screenshots location, specify
`--run-dir` explicitly.

To apply the reviewed plan:

```powershell
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh" --apply
```

This requires Microsoft Edge installed. A visible dedicated reusable Edge session
opens the car list. Log in normally, complete site verification, return to
the FH6 car list, and press Enter in the terminal. Check the account and
preview, then type the requested `APPLY <count>` confirmation. Closing or
cancelling before confirmation sends no updates.

Only additions are sent, sequentially, using `garage.set` with `action=add`,
`set=1`, and the reviewed KudosPrime car ID. No cars are removed.
Before posting, sync reads the account's owned (`garage=y`) and missing
(`garage=n`) FH6 car lists through the authenticated browser session; the
visible page and its filters do not matter. Cars already owned are confirmed
without sending another addition (KudosPrime rejects duplicate adds with
`garage.saveFailed`). If either list cannot be read (for example login or
verification is required), the lists overlap, or a planned car is in neither or
both lists, sync stops before sending any additions.
API failures include the site's error code and message when available.
Cookies and browser data remain in the dedicated local KudosPrime profile
described below; no cookies are copied from your regular browser or exported
into the run. The tool requires HTTP success and JSON `success: true` for each
addition, stops on the first error, and writes a timestamped sync result
file containing only car names/IDs and confirmed/uncertain statuses.
Network timeouts may occur after the server applied an update; inspect the
account before retrying uncertain entries. No retries are automatic.
Live API behavior must be verified with your account; mock tests do not
prove end-to-end garage updates.

### ForzaGarage tracker sync

ForzaGarage has no account or server-side garage API: its Car Tracker stores
unlocked car IDs in the current browser's local storage. Generate and preview
its plan with:

```powershell
npm run ownership -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
npm run sync -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage --apply
```

Runs created before this adapter was added need a ForzaGarage catalog snapshot.
Rerun matching before ownership review to download the registered catalogs.
If PowerShell strips npm options, invoke the CLI directly:
`node --use-system-ca .\src\cli\match-ordinals.ts --run-dir ".\screenshots\scan-YFrlNh"`.
Distinct tracker IDs with identical display names remain ambiguous and are
excluded from the owned plan for manual review.

### Local saved-run dashboard

Start the local interface for an existing run (matching/ownership inputs can
be generated from the dashboard if they are missing):

```powershell
node .\src\cli\review-web.ts --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
# Or: npm.cmd run review:web -- --run-dir ".\screenshots\scan-YFrlNh" --site forzagarage
```

Open `http://127.0.0.1:4173` (use `--port` to choose another port).

- **Load selection** switches between saved `scan-*` runs and supported sites.
- **Refresh catalogs & match names** downloads the registered public catalogs,
  updates the shared name mapping's suggestions and writes the matching outputs.
- **Run ownership OCR** processes existing tiles with progress in the job log.
  Both jobs run sequentially; inputs/selection are locked while a job is running.
- Review filters show unresolved owned cars, owned, unknown, unowned, all tiles
  or manually matched tiles. Each tile displays its image and original OCR.
- **Save ownership correction** requires inspecting the tile and checking the
  verification box. Corrections are recorded in `ownership-overrides.json`;
  the original OCR evidence is retained. Corrections apply across sites for
  this run and survive subsequent OCR passes. **Restore OCR classification**
  removes a correction.
- **Save match & next** confirms an exact site ID. Suggested catalog cars are
  not automatically accepted; search all cars when years or branding differ.
- **Regenerate owned plan** rebuilds the selected site's plan from evidence,
  ownership corrections and mappings, without OCR.
- **Preview sync plan** lists the actual saved additions and excluded reasons.
  Regenerate if another site's plan is stale after ownership changes.
- **Open Edge for sync** opens a dedicated reusable KudosPrime session or a
  temporary ForzaGarage session, but sends no additions.
  Verify login/starting collection, check the destination confirmation box,
  type `APPLY <count>` exactly, then choose **Apply confirmed plan**. The
  dashboard shows sequential progress, audit path, errors and the collection
  share link where supported. **Close Edge / cancel session** is available
  before applying and after completion/failure, not during active updates.

Each save records the exact site ID in the run's `forzagarage-car-mapping.json`
and regenerates `forzagarage-owned-plan.json` from saved ownership evidence
without rerunning OCR. This handles duplicate display names by selecting an
explicit ID. Matches apply to individual tiles, do not edit the shared
`car-name-mapping.json`, and are also honored by subsequent ownership review.
Unknown/unowned tiles are excluded until you explicitly verify and save an
owned correction.
**Remove manual match** restores normal matching; **Skip for now** saves nothing.

The server binds only to loopback; screenshots and OCR stay local. No tracker
updates are sent without explicit sync confirmation. Stale dashboard edits
and changed plans are rejected. Use **Reload local files** after external
edits to evidence, catalogs or mappings. Failed syncs stop immediately and
retain the Edge window for inspection; inspect audit results and the
destination before retrying uncertain entries. No retries are automatic.
Close the sync browser after copying any share link. Ctrl+C stops the server.
New capture/keyboard automation stays in the terminal (`npm run run`).

KudosPrime sync (dashboard and CLI) uses a dedicated reusable Edge profile at
`%LOCALAPPDATA%\fh-scanner\browser-profiles\kudosprime`, outside the project and
OneDrive. Login, verification cookies and other browser data persist locally
after closing Edge. Your regular Edge profile is never opened or copied.
Only one scanner session can use this profile at a time. Always check the
logged-in account before confirming a sync. To reset the login/browser data,
close all scanner sync sessions, then delete only that dedicated profile folder.
KudosPrime also uses experimental automation-flag compatibility settings:
it omits `--enable-automation`, sets
`--disable-blink-features=AutomationControlled`, and initializes
`navigator.webdriver` to `undefined` in new documents. These settings do not
solve interactive challenges or guarantee the site accepts automated browsers.
No `--no-sandbox` argument is added. ForzaGarage does not use these settings.
If verification keeps looping, close the sync session without applying.

ForzaGarage sync opens a temporary Edge session. If you already have ForzaGarage
progress, open its existing “Share my garage” link in that window and choose
“Load this collection” before confirming the plan; otherwise the temporary
session starts with an empty collection. The adapter marks cars through the
tracker UI and verifies the browser-storage update. It does not contact an
account API or remove cars. Afterward, the shareable collection URL is written
to a timestamped `forzagarage-sync-*.url.txt` file in the run directory. Open
that URL in your regular browser and choose “Load this collection” to transfer
the updated list. Loading a share link replaces the current selection in that
browser, so preserve any existing progress first. The selected car IDs are
encoded in the URL fragment and are not sent to ForzaGarage's server.

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
4. Match OCR text against the [HDR ordinal catalog](https://gist.github.com/HDR/fe980cb41c64bdc264dca7bd8c9cdfdc)
   and [KudosPrime FH6 names](https://www.kudosprime.com/fh6/fh6_cars_id_names.js)
   and ForzaGarage's [FH6 Car Tracker](https://forzagarage.com/car-tracker/);
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
  HDR identifiers are Forza ordinals; site IDs are explicitly prefixed by
  their adapter ID (for example, `kudosprime:` or `forzagarage:`) and are not
  Forza ordinals.
- `car-ordinals-source.json`: the downloaded catalog snapshot used for matching.
- `kudosprime-source.js`: the downloaded KudosPrime data snapshot. Its JSON
  array is parsed as data; downloaded JavaScript is never executed.
- `forzagarage-source.json`: the compact ForzaGarage tracker catalog snapshot.

Exact normalized matches search all available catalogs. When multiple sources
match the same normalized name, the HDR name/ordinal takes precedence. Existing
manual selections always take precedence. Pending mappings that now have an
exact site-catalog match are resolved automatically; fuzzy suggestions still
require manual selection. Suggestions include same-year names from the
available catalogs. Site-only output retains the catalog's capitalization.

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
`selected` null unless an exact KudosPrime match is now available.
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
# Offline/reproducible matching with a previously saved catalog:
npm run match -- --run-dir ".\screenshots\scan-YFrlNh" --catalog ".\screenshots\scan-YFrlNh\car-ordinals-source.json" --kudos-catalog ".\screenshots\scan-YFrlNh\kudosprime-source.js" --forzagarage-catalog ".\screenshots\scan-YFrlNh\forzagarage-source.json"
```

Matching downloads the enabled public catalogs over HTTPS by default. To replay
them offline, supply `--catalog`, `--kudos-catalog` and
`--forzagarage-catalog` snapshot paths.
Matching, ownership review and sync all default to the newest `scan-*` folder
by creation time under the project's `screenshots` directory and log the
selected path. An explicit `--run-dir` overrides discovery. Missing input
files fail on that selected run; commands never silently choose an older run.
The scanner always creates a new run under the same default screenshots
directory; `--screenshots-dir` overrides its output location.
Supplying `--catalog` alone uses only HDR for compatibility with older runs; it cannot
validate mappings that refer to site-only names.
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
Dependency installation requires registry access. Ordinal matching separately
requires GitHub access unless using the offline catalog option.

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

Run `npm test` for ordinal matching, site isolation, ownership/sync failure handling,
navigation, options, screenshot-saving, car-tile, monitor/crop tests,
and an OCR recognition smoke test without
capturing the desktop or sending keyboard input. Run `npx tsc --noEmit` to
type-check.

Tests use Vitest in the Node environment with isolated process workers.
Run `npm run test:watch` for watch mode, or
`npm test -- test\car-ordinals.test.ts` to run a single test file.
Configuration lives in `src\vitest.config.ts`; all `test\*.test.ts` files
are discovered automatically. OCR smoke tests have a 30-second timeout.
