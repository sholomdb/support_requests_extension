# Plan: request-based fill (replace DOM automation with the FormTitan API)

Goal: fill requests by calling the site's own API directly (fast, reliable) instead of
driving the DOM. Robust to form edits by **discovering field ids at runtime** rather than
hardcoding `eNNN`. See `API_PROTOCOL.md` for the decoded protocol.

## Principle: don't hardcode volatile ids
`eNNN` element ids are reassigned when the form is edited. The stable anchors are:
- **field label** (e.g. `"מספר זהוי פרטני"`, `"מספר נפשות"`) — present in `preview-page`,
- the Salesforce **binding GUIDs** (`param##<guid>`) — even more stable, if we can tie them
  to an element in the page def.

`preview-page/{MUTAV|CATALOG|WhoHowM}` returns, per field, a node like
`{"uid":"e199","group":"view:p43","label":"מספר זהוי פרטני","subType":"text"}`.
So we build, at runtime, `label -> {uid, group, subType}` and resolve every id we need.
A small **stable label table** (logical field -> label) is the only thing we maintain; if a
label lookup misses, we **fail loudly** ("form changed - update label for X"), never guess.

## What we keep vs. replace
- **Keep unchanged:** Excel parsing, value mappings, budget-source allocation, splitting,
  validation, storage, options UI. The pipeline's per-row `fields` already carry every value.
- **Replace:** `content.js` DOM automation → API client.
- **Add:**
  - `shared/form-schema.js` — fetch + parse `preview-page` into the field map; cache per
    form-version hash so it's fetched rarely.
  - `shared/api.js` — the request client: `getMapping()` / `push()` wrappers over
    `webprojects/get|push/sfmapping`, plus the per-step flows.
  - `shared/ft-auth.js` — supplies the session headers (see Auth).

## Auth (reuse the recorder we already built)
Every call needs headers `kbgr8jmwl3r1ffbw3nilg`, `tc4gftmj5twjryy3bxcbqs3n`, `sfauthhash`,
`fturl` (issued after SMS login; they expire). Instead of reimplementing login, the recorder
mechanism persists the **latest seen** auth headers to storage; `ft-auth.js` reads them and
`api.js` replays them on our own `fetch`. On an auth failure, prompt the operator to open/
refresh the site (re-harvests fresh headers). Requests run from the extension against the
`ifcjil.formtitan.com` origin (host permission already granted).

## The per-row flow (from API_PROTOCOL.md)
1. `GET preview-page/*` (once per form version) → field map.
2. **MUTAV:** `get e2847` with `{e199: idNumber}` → **contact id** `001N…` + person fields;
   `push e238` with a `state` built from our row `fields` mapped through the field map.
3. **CATALOG:** `get e421` with item text + budget label → **item id** `a10…`.
4. **WhoHowM:** `get e424` with contact id + date + budget label →
   **budget-source id `a3V…`, remaining, request-record id `a0R…`**; supplier/amount lookups;
   `push e361` with the combined `state`.
Carry the SF ids between steps in memory (never hardcoded).

## Rollout (de-risk before the big rewrite)
- **Phase 0 - auth spike (tiny):** `api.js` performs ONE call - the ID lookup - with harvested
  headers. Popup dev button shows the response. Proves header replay works end to end. If it
  fails, we learn the constraint before building anything else.
- **Phase 1 - read-only dry run:** resolve the whole chain for a row (contact/item/budget-
  source/request-record ids) and **log the exact `state` we WOULD push**, without pushing.
  Diff against a known-good manual submission's recorded push to validate field-for-field.
- **Phase 2 - writes:** enable `push` behind an explicit toggle, one row at a time, keeping the
  existing balance-verification safeguards. Idempotency guard so a retried row can't double-
  submit (the push creates records).
- **Fallback:** keep the DOM automation available during the transition; switch per-run.

## Open items to resolve during Phase 0/1
- Is `sfauthhash` required on the XHR pushes? (present in HAR, not in the XHR capture).
- The full **required** `state` field set for each push (derive from `preview-page` rules, or
  from a captured known-good push) vs. which fields are optional/derived server-side.
- Whether to anchor discovery on **labels** (simple) or **binding GUIDs** (sturdier) - decide
  after inspecting whether preview-page ties `eNNN` to the `param##<guid>` bindings.
- Recovery UX when auth headers expire mid-batch.

## Recommendation
Start with **Phase 0** (auth spike) - a few hours, no rewrite - because auth replay is the
single biggest unknown. Everything else is mechanical once it's proven.
