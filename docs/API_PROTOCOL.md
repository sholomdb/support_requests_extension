# FormTitan API protocol (reverse-engineered)

Decoded from in-extension traffic recordings of one full "new request" flow (משפחות /
מודיעין עילית). This is the reference for a future request-based fill that replaces the
DOM automation. **No secrets are in this file** — auth token values are never recorded here.

## Endpoints (all `POST` unless noted), base `https://ifcjil.formtitan.com/webprojects/`

| Endpoint | Content-Type | Purpose |
|---|---|---|
| `GET preview-page/{MUTAV\|CATALOG\|WhoHowM}` | — | Full page definition JSON (field/rule GUIDs). ~40–80 KB. |
| `get/sfmapping` | `application/json` | Every read/lookup: ID lookup, item search, budget-source list, price/balance calc, supplier. |
| `push/sfmapping` | `multipart/form-data` | The real writes: MUTAV "next" (`elemUID=e238`) and final submit (`elemUID=e361`). |
| `quote/isAllow` | `application/json` | Session/permission ping (body `{}` → `{"isAllow":true}`-ish). |
| `get/sse/sfmapping` | — (SSE) | Server-sent init stream; not needed for the write flow. |

## Auth (per request, headers — NOT cookies)
Every `webprojects` call carries three custom headers, issued after the SMS login:
- `sfauthhash` *(seen in the HAR; sometimes absent on XHR — confirm)*
- `kbgr8jmwl3r1ffbw3nilg` — ~704-hex session token
- `tc4gftmj5twjryy3bxcbqs3n` — ~704-hex session token
- plus `fturl: https://ifcjil.formtitan.com/ftproject/ifcjaid/IFCJAIDHOME`

**Strategy:** don't reimplement login. Harvest these headers from live page traffic (same
recorder mechanism) and replay them on our own `fetch` calls. They expire, so capture-fresh.

## The flow (one request)

### 0. Home page
`get/sfmapping` calls load the logged-in contact + budget-source PowerTable (`e978`):
`PowerTableWidget:e978…:value` = SF ids, `…:90d5826b…` = source names, `…:4345…` = framework,
`…:5ca47b4d…` = **remaining balance**. (This is the balances table we already read from DOM.)

### 1. MUTAV — person details
- **ID lookup** — `get/sfmapping`, `elemUID=e2847`, body:
  `{"data":{"list":{"<uuid>":{"view:p43#-#p43:e199":"<idNumber>"}},"elemUID":"e2847"}}`
  Response pre-fills the person and, crucially, returns SF ids:
  - `param#-#ce55f641-…` = **contact id** `001N…` (reused in every later push)
  - `view:p43#-#p43:e229:ft_value` = city id `a08D…`, `…e229:ft_text` = city name
  - plus e200/e201 names, e209 gender, e212 marital, e213 household size, e217 birthdate
    (`YYYY-MM-DD`), e216 birth country, e2848 holocaust, e231 mobile, e232 home, e224 building…
- **Submit step 1** — `push/sfmapping` multipart:
  `elemUID=e238`, `actionRuleId`, `nodeId` (both stable GUIDs from preview-page), and
  `state` = JSON of all `view:p43##p43:eNNN` fields + `param##<contactGuid>` = contact id.
  Response: `{"status":true,"data":{...: "001N…"}}` (echoes contact id).

### 2. CATALOG — pick the item
- **Item search** — `get/sfmapping`, `elemUID=e421`, body carries
  `view:p239#-#p239:e421` = item text + `e687:ftListValue` = budget label. Response returns
  the item's SF id `a10…` (`…s287:a10e5c5c…`) + its category + which budgets allow it.

### 3. WhoHowM — amount, budget source, supplier, submit
Chained `get/sfmapping` lookups (rule-driven) resolve, from ids gathered so far:
- **budget source** — `get/sfmapping`, `elemUID=e424`, `ruleUID="action"`, body sends the
  **contact id** (`param#-#ec14481b…`), the **date** (`param#-#05a35fde…` = `YYYY-MM-DD`) and
  the **budget label** (`param#-#fb183616…`). Response returns everything about the source:
  - `view:e424#-#p298:e424:value` = budget-source id `a3V…`
  - `view:e424#-#p298:e424:text`  = full source name
  - `view:e424…:<guid1>` = remaining balance (e.g. 216747)
  - `view:e424…:<guid2>` = **the request-record id `a0R…`**
  So the request record is materialized by selecting the budget source — there is **no
  separate "+ רשומה חדשה" creation call** to replay.
- supplier `e304:ft_value` = `a11…`; amount `e305`; item `e360`.
- **Final submit** — `push/sfmapping` multipart: `elemUID=e361`, `actionRuleId`, `nodeId`,
  and a large `state` JSON combining contact id, budget-source id/text, supplier id, amount,
  item, request-record id, and `pageParam##p298:…` values gathered from the lookups.
  Response: `{"status":true,"data":{...:"a1a…", ...:"a3W…"}}` — the created record ids.

## Key implications for implementation
- **It's a chained, stateful protocol, not a simple form POST.** Each write needs SF record
  ids produced by earlier reads (contact ← ID lookup, item ← catalog search, budget source ←
  WhoHowM lookup, request-record ← budget-source lookup). We must replay the read chain, not
  just the final push.
- The `actionRuleId`/`nodeId`/field-GUIDs are **stable** (from `preview-page`), so they can be
  captured once and reused; the SF ids are **per-record** and must be resolved live.
- Field ids (`e199`, `e213`, `e217`, `e229`, `e424`, `e305`, `e361`…) are exactly the selectors
  we already map in `config.js` — the existing pipeline output maps almost 1:1 onto `state`.
- **Reuse unchanged:** Excel parsing, value mappings, budget-source allocation, splitting,
  validation. **Replace:** `content.js` DOM automation → a `shared/api.js` client that does
  preview-page (once) → get/sfmapping chain → push/sfmapping, with harvested auth headers.

## Open questions before building
- Whether `sfauthhash` is required on XHR pushes (present in HAR, not in the XHR capture).
- Full `state` field list for the final push vs. which are optional.
- ~~Origin of the request-record id~~ — **resolved**: returned by the `e424` budget-source
  lookup (see step 3); no separate creation call.
