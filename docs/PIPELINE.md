# Upload-time pipeline

This describes how an uploaded Excel file becomes a table of fillable, validated
requests, and where to make changes when field behavior needs to change. The
underlying spec/notes this was built from are in [`ruls.txt`](../ruls.txt) — this
doc is the maintained, structured version of that; `ruls.txt` itself is left as-is.

## Flow

```
Excel file
  -> excel-parser.js: raw column extraction + simple deterministic fixes
       (padding, date normalization, city alias normalization, amount->number)
  -> pipeline.js collectMappingQueue(): resolve every categorical value
       (city, budget type, item, birth country, family classification,
       budget source) against saved mappings, seeds, then inference fallback.
       Anything still unresolved becomes ONE queue entry per unique value
       (not per row) for the operator to answer once.
  -> operator answers the batched queue (popup.js mapping section) - or skips,
       leaving affected rows `needs-mapping`
  -> pipeline.js buildRow(): pure, synchronous fix + validate per row, using the
       now-resolved mapping cache. No async calls, no per-row prompts.
  -> pipeline.js buildRequests(): row -> one or more fillable "requests"
  -> session.requests is what popup.js/content.js actually iterate and fill
```

Re-uploading (to fix a row): edit the cell in Excel, re-upload the same file.
`rowKey`/`requestId` are scoped to the file (`fileIdOf` = the file name — not size or
a hash, since even a one-character edit changes an xlsx file's saved byte size, and
keying on that would make every fix look like a new file and defeat the merge), so
the pipeline re-parses everything, re-validates the changed row, and merges by key —
rows/requests that already had steps filled keep that progress; the row that changed
gets fresh `fields`/`status` from the new data. Uploading a genuinely different file
that happens to share a name would incorrectly merge against it — an accepted
trade-off given the supported workflow is "edit and re-upload the same file".

## Field table

Source: `extension/shared/pipeline.js`, `FIELD_PIPELINE`. Edit that array to change
any of this — it's the single place fix/validate logic lives.

| Output field | Excel source | Fix | Validate | Step |
|---|---|---|---|---|
| idNumber | תעודת זהות | pad to 9 digits | must be 9 digits | 1 |
| lastName / firstName | שם משפחה / שם פרטי | trim/normalize | required | 1 |
| gender | מגדר | trim/normalize | required | 1 |
| sector | מגזר | trim/normalize | required | 1 |
| ministryFileExists | (constant) | always `כן` | – | 1 |
| mutavKnowledge | (constant) | always `כן` | – | 1 |
| maritalStatus | מצב משפחתי | trim/normalize | required | 1 |
| householdSize | נפשות | to string | must be > 0 | 1 |
| holocaustSurvivor | ניצול שואה | normalize to כן/לא | – | 1 |
| birthDate | תאריך לידה | normalize to DD/MM/YYYY | must match format | 1 |
| street / building | רחוב / בנין | trim/normalize | – | 1 |
| citySearch | שם הרשות | **mapped** (city), falls back to `getCitySiteSearch` | required (resolved) | 1 |
| settlement | ישוב | only when city is מטה בנימין | required if מטה בנימין | 1 |
| birthCountry | ארץ לידה | **mapped**, falls back to `inferBirthCountry` | required (resolved) | 1 |
| familyClassification | נפשות + מצב משפחתי | **mapped**, falls back to `inferFamilyClassification` | required (resolved) | 1 |
| mobilePhone / homePhone | טלפון נייד | `routePhone`: pad to 10 digits — if `05` → mobile (10 digits); else → home padded to **9** digits, and if that doesn't start with a valid area code (02/03/04/08/09) it becomes the placeholder `020000000` | one of the two has a value | 1 |
| budgetType / budgetLabelIndex | סוג תקציב | **mapped** to CATALOG label index | required (resolved) | 2 |
| item / itemSelector / itemMaxPrice | פריט | **mapped** to a catalog item name; max price from catalog-data.js | required (resolved) + must exist in the row's budget | 2 |
| budgetSource | סוג תקציב + שם הרשות | **mapped**, keyed by budget type + city | required (resolved) | 3 |
| amount | סכום סיוע בש"ח | to string | must be > 0 | 3 |
| reason | נימוקים לאישור | trim/normalize | – | 3 |
| supplier | (constant) | always `אש"ל חב"ד ירושלים` | – | 3 |

"**mapped**" fields go through the batched operator-taught mapping store
(`extension/shared/mappings.js`) — view/edit/delete them any time in the extension's
Settings page, or use the "תקן מיפויים" button in the side panel to re-run just the
resolution step without a re-upload.

### Categories (picklists) for mapped fields

Every mapped field's operator-facing suggestion list is `HARDCODED_SUGGESTIONS[type]`
(a small built-in starting list — empty for `item`/`budgetSource`, since those have no
fixed site enum) unioned with a `categories` list stored in `chrome.storage.local` that
anyone can edit any time in Settings → "קטגוריות". `saveMapping()` automatically adds
whatever site value was just chosen to that stored list, so `item`/`budgetSource`
become real categorical picklists purely through use — the first time an item is
mapped it's free text, every time after that it shows up as a suggestion, for any row.
Built-in values can't be removed from Settings (no ✕ shown for them); only
operator-added ones can.

## Item selectors and price limits

The catalog only renders items after a budget type is picked, and each item is its
own DOM element — there's no single shared selector. Which items exist per budget and
their "מחיר מירבי" (max price) live in the generated
[`catalog-data.js`](../extension/shared/catalog-data.js) (see the "Catalog" section
below). Operators can additionally capture a DOM selector / price override at runtime
via the "לכוד סלקטור" button next to an item mapping in Settings (arms a one-time
click-to-capture on the FormTitan tab, then optionally prompts for the max price);
these are stored in `chrome.storage.local` (`getItemMaxPrice`/`setItemInfo` in
`mappings.js`). Items are normally matched by searching the catalog and clicking the
result rather than by a fixed selector (`content.js`'s `fillCatalogPage`).

Clicking an item always navigates straight to the WhoHowM page, so a click's success
is verified by actually *arriving* there (`waitForWhoHowMPage` checks for the
`whohowm` page type specifically, not just "no longer catalog" — a transient DOM
blip during re-render can otherwise look like a false-positive navigation) rather
than assumed from "an element was found and a click event fired".

**Search first, then click a fixed "first result" index - not any specific item's
own id.** The catalog is rendered by a column repeater (`data-ft-repeat-col` on its
root, e.g. `#s287`), and each item's own DOM id includes a per-render instance suffix
(e.g. `#e290_44`) that's tied to render/layout position - observed in practice to
change between two consecutive fills of the *same* row (the budget being re-clicked
each time re-rendered the item list), and it may also depend on how many columns the
layout renders (viewport width, item count for that budget). Rather than trying to
identify one item among many, `clickCatalogItem` types the item's display text into
the catalog's item search box (`selectors.step2.itemSearch`, default `#e421`) and
then requires a **unique match** before clicking: after the wait it counts the
visible item cards (`visibleRepeaterItems`) and only proceeds if exactly one remains
(or, if several substring-matches appear, exactly one whose caption is an exact match
via `cardHasExactItem`). Zero results means the search found nothing; many results
mean the search didn't narrow down (or silently didn't run) - both fail with a clear
Hebrew reason rather than clicking a guess. If search isn't configured or doesn't work, it falls back
to text-matching the rendered catalog (still layout-independent, just less precise
than a filtered single result), then the captured selector as a last secondary check
(see item-catalog.js), then the item's whole repeater cell
(`ft--st-placeholder`/`repeatPlaceholder`/`droppable`) as a broader fallback - every
attempt is verified the same way (see below).

Both waits the operator flagged are explicit: `searchForItem` waits for the search
box to actually exist (`waitForElement`, since it only renders after the budget is
picked) before typing, then waits `settings.searchWaitMs` after typing for the
filtered results to render before clicking.

`fillCatalogPage` always (re-)clicks the budget label on every fill attempt - an
earlier version tried to skip that click when the item already appeared rendered,
to avoid re-render churn invalidating the item's captured selector, but that
assumption turned out to be wrong for this site (items can appear present
regardless of budget selection) and it ended up skipping the real, working budget
click. Removed; `isVisible()` was still worth hardening to check actual CSS
visibility/display/opacity up the ancestor chain (not just bounding-box dimensions,
which stay non-zero even for `visibility:hidden` elements) since `collectOptionElements`
relies on it elsewhere.

Within the located card, `clickCatalogItem` tries several candidate elements in
order (the `.pointed`/cursor:pointer image wrapper, its `<img>`, then the card
container itself) since it's not certain which one carries FormTitan's navigation
handler - each verified by an actual page transition, with a short per-candidate
wait. The reported failure reason lists exactly which elements were clicked, by
strategy and id (e.g. `search:pointed#e290_0, search:img, search:card#s287-Col1i0`),
so a stalled fill's log pinpoints what to look at next rather than needing to guess.

Clicks are simulated by `dispatchClick`, which fires the full pointer+mouse sequence
(pointerover → pointerdown → mousedown → focus → pointerup → mouseup → click) at the
element's real center coordinates - `(0,0)`-defaulted synthetic events were being
ignored/treated as drags by this drag-and-drop-capable UI. If even this can't drive
the item click (while a manual click works), the remaining gap is `event.isTrusted`,
which no DOM dispatch can fake - that would require driving input via the Chrome
DevTools Protocol (`chrome.debugger` + `Input.dispatchMouseEvent`).

## Catalog: item existence, prices, and splitting

[`extension/shared/catalog-data.js`](../extension/shared/catalog-data.js) is generated
by [`scripts/gen-catalog-data.mjs`](../scripts/gen-catalog-data.mjs) from the six
[`extension/catalogs/*.txt`](../extension/catalogs) files (one per budget). It maps
`budget label -> { item name: מחיר מירבי }` (price `null` = listed but no limit). Edit
the `.txt` files and re-run `node scripts/gen-catalog-data.mjs` to update it.

It drives three things:
- **Item categories** — `catalogItemNames()` (every distinct item across budgets) seeds
  both the item picklist (`HARDCODED_SUGGESTIONS.item`) and the item seeds
  (`DEFAULT_SEEDS.item`, so an Excel item exactly matching a catalog name auto-resolves).
- **Item-in-budget validation** — `buildRow` flags a row `INVALID` (error on the `item`
  field) when the resolved budget is a known catalog budget but the resolved item isn't
  in it (`budgetHasItem`). This is a cross-field check, run after both are resolved.
- **Splitting** — `row.fields.itemMaxPrice` is set from `catalogMaxPrice(budget, item)`,
  and `buildRequests` splits an over-limit amount into chunks of at most that price (see
  below). A `null` price means no limit → no split.

## Request splitting (`buildRequests` / `buildAllRequests`)

`splitAmount(total, maxPrice)` chops a total into chunks no larger than the item's
per-budget limit — e.g. 900 with a 500 limit → `[500, 400]`. `buildRequests(row)` turns
each chunk into its own request with all other fields identical; `requestId` is
`${rowKey}::${chunkIndex}` where `rowKey = fileId::idNumber::excelRow`. Because the split
is deterministic from `(amount, limit)`, re-uploading the same file reproduces identical
requestIds, so `mergeRequestsOnReupload` still matches each chunk and preserves its
per-step progress. `buildAllRequests(rows)` orders every row's primary chunk (`::0`) in
row order first, then appends the overflow chunks (`::1`, `::2`, …) at the end, so a
split "adds the same row again at the end" rather than interleaving. Requests carry
`splitIndex`/`splitCount` for the "חלק k/n" label in the row list.

## Two seams for known future work

- **Transport** (`content.js`): it's a DOM-fill adapter — it receives a `request.fields`
  object (plain data, no DOM handles) via the `FILL_STEP`/`CLICK_NEXT`/etc. message
  contract and manipulates the page. A future GET/POST-based adapter would implement
  the same message contract against the same `fields` shape; `pipeline.js` and
  `popup.js` would not need to change.

## Exporting

The "ייצוא טבלה + יומן" button in the side panel writes an `.xlsx` (via the already
bundled SheetJS build) with the full processed `requests` table (raw values, resolved
fields, per-step status, validation errors) on one sheet and the persisted fill log
on another — openable outside the extension at any time, not just at the end.
