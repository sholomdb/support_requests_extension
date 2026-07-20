/**
 * Headless request-based fill orchestrator.
 *
 * Ties together schema discovery (preview-page) and the chained get/sfmapping reads into a
 * single pass per request, and BUILDS the push requests without sending them. Two phases
 * coexist in one run:
 *   1. discover  - GET preview-page/{MUTAV,WhoHowM} once, resolve the push rule ids (the
 *                  "dry run to figure out the element ids"); cached on the ctx.
 *   2. resolve   - per request: id-lookup → item-search → budget-source reads, gathering the
 *                  SF ids (contact/item/budget-source/request-record), then assemble the MUTAV
 *                  and final push `state`s.
 *
 * Writes are gated by opts: `pushMutav` sends the MUTAV e238 push (first-stage record, safe),
 * `submitFinal` sends the e361 final submit (creates the aid request - OFF by default; the
 * operator opts in explicitly). With both off this is a pure dry run that logs what it WOULD do.
 *
 * `fetchApi(request)` is injected (the popup passes a fn that proxies through the content
 * script's same-origin API_FETCH). Everything here is pure orchestration → unit-testable.
 */
import {
  buildIdLookupRequest,
  buildItemSearchRequest,
  buildBudgetSourceRequest,
  buildPushRequest,
  parseIdLookup,
  parseItemSearch,
  parseBudgetSource,
  isAuthFailure,
} from './api.js';
import { buildPreviewPageRequest, parsePreviewPage, findPushRule } from './form-schema.js';
import { assembleMutavState } from './state-assembler.js';
import { BIND } from './api.js';

export const AUTH_ERROR = 'AUTH';

class FlowError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function callJson(fetchApi, request, label) {
  const res = await fetchApi(request);
  if (!res?.ok) throw new FlowError(`${label}: ${res?.error || 'status ' + res?.status}`);
  if (isAuthFailure(res.status, res.text)) throw new FlowError(`${label}: הסשן פג – התחבר מחדש`, AUTH_ERROR);
  return res.text;
}

/** Phase 1: fetch + parse the push-form schemas once, returning discovered rule ids. Cached on
 * `ctx.schemas` so a batch pays the preview-page cost a single time. */
export async function discoverSchemas(fetchApi, auth, ctx = {}) {
  if (ctx.schemas) return ctx.schemas;
  const out = {};
  for (const form of ['MUTAV', 'WhoHowM']) {
    const text = await callJson(fetchApi, await buildPreviewPageRequest(form, auth), `preview-page/${form}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FlowError(`preview-page/${form}: תשובה לא תקינה`);
    }
    const schema = parsePreviewPage(json);
    out[form] = { schema, pushRule: findPushRule(schema, form) };
  }
  ctx.schemas = out;
  return out;
}

/**
 * Resolves + assembles one request end to end. Returns a trace:
 *   { ids:{contactId,itemId,priceCap,sourceId,remaining,recordId}, mutavState, finalState,
 *     pushed:{mutav,final}, requests:{mutavPush,finalPush} }
 * Reads always run (safe). Pushes run only if opts allow; otherwise their built request is
 * returned unsent for inspection/logging.
 */
export async function runRequest(request, { fetchApi, auth, ctx = {}, opts = {} }) {
  const f = request.fields || {};
  const schemas = await discoverSchemas(fetchApi, auth, ctx);
  const trace = { ids: {}, requests: {}, pushed: { mutav: false, final: false }, log: [] };
  const note = (m) => trace.log.push(m);

  // --- MUTAV: id lookup → assemble e238 state ---
  const lookText = await callJson(fetchApi, await buildIdLookupRequest(f.idNumber, auth), 'id-lookup');
  const look = parseIdLookup(lookText);
  const lookupData = safeData(lookText);
  trace.ids.contactId = look.contactId;
  note(`ת.ז. ${f.idNumber} → contact ${look.contactId || '?'}`);

  const accountId = ctx.accountId || auth.accountId || '';
  const overrides = {
    'view:p43##p43:e199': String(f.idNumber ?? ''),
  };
  if (f.familyClassification) overrides['view:p43##p43:e218:ftListValue'] = f.familyClassification;
  if (accountId) overrides[`param##${BIND.paramAccountId}`] = accountId;
  trace.mutavState = assembleMutavState(lookupData, overrides);
  trace.requests.mutavPush = buildPushRequest(
    { elemUID: 'e238', ...schemas.MUTAV.pushRule, state: trace.mutavState },
    auth,
  );

  if (opts.pushMutav) {
    await callJson(fetchApi, trace.requests.mutavPush, 'MUTAV push');
    trace.pushed.mutav = true;
    note('MUTAV נשלח (רשומת שלב 1)');
  } else {
    note('MUTAV לא נשלח (dry-run)');
  }

  // --- CATALOG: item search --- (pipeline field names: itemSiteValue = the item display text,
  // budgetSiteValue = the budget label like "סיוע חירום למשפחות")
  const itemText = f.itemSiteValue;
  const budgetLabel = f.budgetSiteValue;
  if (itemText && budgetLabel) {
    const itemResp = await callJson(
      fetchApi,
      await buildItemSearchRequest(itemText, budgetLabel, { auth, guid: ctx.pageGuid }),
      'item-search',
    );
    const item = parseItemSearch(itemResp);
    trace.ids.itemId = item.itemId;
    trace.ids.priceCap = item.priceCap;
    note(`פריט "${itemText}" → ${item.itemId || '?'} (תקרה ${item.priceCap || '?'})`);
  } else {
    note('אין פריט/תקציב לחיפוש קטלוג – מדלג');
  }

  // --- WhoHowM: budget-source lookup → materializes the request record ---
  if (accountId && budgetLabel) {
    const bsText = await callJson(
      fetchApi,
      await buildBudgetSourceRequest(
        { accountId, dateISO: ctx.dateISO, budgetLabel },
        { auth, guid: ctx.pageGuid },
      ),
      'budget-source',
    );
    const bs = parseBudgetSource(bsText);
    trace.ids.sourceId = bs.sourceId;
    trace.ids.remaining = bs.remaining;
    trace.ids.recordId = bs.recordId;
    note(`תקציב "${f.budgetLabel}" → מקור ${bs.sourceId || '?'}, יתרה ${bs.remaining ?? '?'}, רשומה ${bs.recordId || '?'}`);
  } else {
    note(accountId ? 'אין תווית תקציב – מדלג על מקור' : 'אין מזהה חשבון (accountId) – לא ניתן לפתור מקור/רשומה');
  }

  // Final submit (e361) is intentionally NOT assembled/sent here yet - the operator asked to
  // hold it back until validated. buildFinalPush + submitFinal land in a follow-up.
  note('שליחה סופית (e361) חסומה – שלב הבא');
  return trace;
}

function safeData(text) {
  try {
    return JSON.parse(text)?.data || {};
  } catch {
    return {};
  }
}
