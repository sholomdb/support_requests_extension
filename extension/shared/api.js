/**
 * FormTitan request client (Phase 0 - auth spike).
 *
 * Builds direct API calls against webprojects/{get,push}/sfmapping using the session auth
 * headers harvested by the recorder (ft-auth.js). Requests are *built* here but EXECUTED by
 * the content script (API_FETCH message) so the fetch is same-origin on ifcjil.formtitan.com -
 * cookies attach automatically, custom headers are allowed, and the Origin/Referer match the
 * app (a background-worker fetch would carry a chrome-extension:// origin the server may reject).
 *
 * Phase 0 hardcodes the ID-lookup field ids from a recording to prove auth replay works; Phase 1
 * replaces these with runtime discovery from preview-page (see docs/API_MIGRATION_PLAN.md).
 */
import { getFtAuth } from './ft-auth.js';

export const API_BASE = 'https://ifcjil.formtitan.com/webprojects';

// Provisional ids (Phase 0). TODO(phase 1): discover from GET preview-page/MUTAV by label.
const MUTAV_GROUP = 'p43';
const FIELD_ID_NUMBER = 'e199'; // "מספר זהוי פרטני"
const ELEM_ID_LOOKUP = 'e2847'; // the ID-lookup trigger

// Stable binding GUIDs used inside the read requests (from preview-page rules; they change
// only when the form is edited, not per record). Response-side SF ids are parsed structurally
// (by their Salesforce prefix) instead, so we don't hardcode response GUIDs.
export const BIND = {
  itemSearchRule: 'da3314cc-7449-43cf-bb30-58a2d31608f8', // e421 processRule
  paramBudgetLabel: 'fb183616-3946-40fb-a13b-326aa080fd42', // budget label (shared by e421 child + e424)
  paramItemAllow: 'cd46524a-afc9-4827-a5f5-e19840dddf42', // "true" allow flag on e421 child
  paramAccountId: 'ec14481b-095b-44b8-875c-69e87aa34b2f', // logged-in account id into e424
  paramDate: '05a35fde-25e1-4823-9dc4-7e40a7523a1b', // request date (YYYY-MM-DD) into e424
};

const CATALOG_GROUP = 'p239';
const FIELD_ITEM_SEARCH = 'e421';
const FIELD_BUDGET_LABEL = 'e687';
const ELEM_BUDGET_SOURCE = 'e424';

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Builds the ID-lookup request ({url, method, headers, body}) to POST to get/sfmapping.
 * Throws if no auth has been harvested yet. `auth` can be injected (tests); otherwise read
 * from storage. */
export async function buildIdLookupRequest(idNumber, auth) {
  auth = auth || (await getFtAuth());
  if (!auth?.headers || !Object.keys(auth.headers).length) {
    throw new Error('לא נלכדו כותרות אימות – פתח או רענן את אתר FormTitan תחילה');
  }
  const body = {
    data: {
      list: { [uuid()]: { [`view:${MUTAV_GROUP}#-#${MUTAV_GROUP}:${FIELD_ID_NUMBER}`]: String(idNumber) } },
      ruleUID: null,
      elemUID: ELEM_ID_LOOKUP,
      guid: null,
    },
  };
  return {
    url: `${API_BASE}/get/sfmapping`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    body: JSON.stringify(body),
  };
}

function requireAuth(auth) {
  if (!auth?.headers || !Object.keys(auth.headers).length) {
    throw new Error('לא נלכדו כותרות אימות – פתח או רענן את אתר FormTitan תחילה');
  }
}

/** JSON get/sfmapping request builder shared by the read lookups. `guid` is the page-instance
 * token some rule-driven lookups carry (null for the id lookup). */
function getMappingRequest({ elemUID, ruleUID = null, processRule, guid = null, row, children }, auth) {
  const item = { ...row };
  if (children) item.childrens = { list: { [uuid()]: children } };
  const data = { list: { [uuid()]: item }, ruleUID, elemUID, guid };
  if (processRule) data.processRule = processRule;
  return {
    url: `${API_BASE}/get/sfmapping`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    body: JSON.stringify({ data }),
  };
}

/** CATALOG item search (elemUID=e421): resolves an item's SF id + category + price cap from
 * its display text and the budget label. `guid` is the page-instance token (harvested live). */
export async function buildItemSearchRequest(itemText, budgetLabel, { auth, guid = null } = {}) {
  auth = auth || (await getFtAuth());
  requireAuth(auth);
  return getMappingRequest({
    elemUID: FIELD_ITEM_SEARCH,
    ruleUID: BIND.itemSearchRule,
    processRule: BIND.itemSearchRule,
    guid,
    row: {
      [`view:${CATALOG_GROUP}#-#${CATALOG_GROUP}:${FIELD_ITEM_SEARCH}`]: String(itemText),
      [`view:${CATALOG_GROUP}#-#${CATALOG_GROUP}:${FIELD_BUDGET_LABEL}:ftListValue`]: String(budgetLabel),
    },
    children: {
      [`param#-#${BIND.paramBudgetLabel}`]: String(budgetLabel),
      [`param#-#${BIND.paramItemAllow}`]: 'true',
    },
  }, auth);
}

/** WhoHowM budget-source lookup (elemUID=e424, ruleUID="action"): given the account id, the
 * request date and the budget label, returns the budget-source id, its remaining balance and -
 * crucially - the materialized request-record id (a0R…). */
export async function buildBudgetSourceRequest({ accountId, dateISO, budgetLabel }, { auth, guid = null } = {}) {
  auth = auth || (await getFtAuth());
  requireAuth(auth);
  return getMappingRequest({
    elemUID: ELEM_BUDGET_SOURCE,
    ruleUID: 'action',
    processRule: 'action',
    guid,
    row: {
      [`param#-#${BIND.paramAccountId}`]: String(accountId),
      [`param#-#${BIND.paramDate}`]: String(dateISO),
      [`param#-#${BIND.paramBudgetLabel}`]: String(budgetLabel),
      'static#-#true': '',
      'static#-#false': '',
    },
  }, auth);
}

/** Builds a push/sfmapping multipart request. Returns {url, method, headers, form}; the content
 * script rebuilds real FormData from `form` (see content API_FETCH). `state` is the field/param
 * object; `actionRuleId`/`nodeId` come from form-schema.findPushRule (discovered, not hardcoded). */
export function buildPushRequest({ elemUID, actionRuleId, nodeId, state }, auth) {
  requireAuth(auth);
  return {
    url: `${API_BASE}/push/sfmapping`,
    method: 'POST',
    headers: { ...auth.headers }, // no Content-Type: the browser sets multipart boundary
    form: {
      elemUID,
      actionRuleId,
      nodeId,
      state: JSON.stringify(state),
      list: JSON.stringify({ [uuid()]: {} }),
    },
  };
}

const SF_PREFIX = { contact: /^001/, account: /^a123/, item: /^a10/, budgetSource: /^a3V/, requestRecord: /^a0R/, supplier: /^a11/ };

/** Parses the id-lookup (e2847) response: the person fields plus the contact id (001N…). */
export function parseIdLookup(text) {
  const r = parseMappingResponse(text);
  if (!r.ok) return r;
  const contactId = Object.values(r.params).find((v) => SF_PREFIX.contact.test(String(v))) || '';
  return { ...r, contactId };
}

/** Parses the item-search (e421) response: item SF id (a10…), its category/code labels and the
 * catalog price cap. SF ids are matched by prefix so no response GUIDs are hardcoded. */
export function parseItemSearch(text) {
  const r = parseMappingResponse(text);
  const data = safeData(text);
  let itemId = '';
  let priceCap = 0;
  const labels = [];
  for (const [k, v] of Object.entries(data)) {
    if (!k.includes('s287')) continue;
    if (SF_PREFIX.item.test(String(v))) itemId = v;
    else if (typeof v === 'number' && /e296/.test(k)) priceCap = v;
    else if (typeof v === 'string' && v && !/^a3k/.test(v)) labels.push(v);
  }
  return { ...r, itemId, priceCap, labels };
}

/** Parses the budget-source (e424) response: budget-source id (a3V…), remaining balance and the
 * request-record id (a0R…) that selecting the source materializes. */
export function parseBudgetSource(text) {
  const r = parseMappingResponse(text);
  const data = safeData(text);
  let sourceId = '';
  let sourceText = '';
  let remaining = null;
  let recordId = '';
  for (const [k, v] of Object.entries(data)) {
    if (k.endsWith(':value') && SF_PREFIX.budgetSource.test(String(v))) sourceId = v;
    else if (k.endsWith(':text')) sourceText = v;
    else if (SF_PREFIX.requestRecord.test(String(v))) recordId = v;
    else if (typeof v === 'number') remaining = v;
  }
  return { ...r, sourceId, sourceText, remaining, recordId };
}

function safeData(text) {
  try {
    return JSON.parse(text)?.data || {};
  } catch {
    return {};
  }
}

/** Heuristic: does a FormTitan API result indicate the session is unauthenticated/expired?
 * (No captured 401 sample yet, so we treat a non-2xx status, or a login/smart-v page in the
 * body, as an auth failure - so the UI can prompt a re-login instead of failing silently.) */
export function isAuthFailure(status, text) {
  if (status === 401 || status === 403) return true;
  if (status && (status < 200 || status >= 300)) return true;
  const t = String(text || '').slice(0, 500).toLowerCase();
  return t.includes('sfsmartv') || t.includes('/smart-v') || (t.includes('<html') && t.includes('login'));
}

/** Extracts eNNN -> value pairs and status from a get/sfmapping response text, for readable
 * display and for later mapping back to our fields. Field keys look like
 * "view:p43#-#p43:e229:ft_text" or "param#-#<guid>". */
export function parseMappingResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, raw: String(text).slice(0, 500) };
  }
  const data = json?.data || {};
  const fields = {};
  const params = {};
  for (const [k, v] of Object.entries(data)) {
    const el = k.match(/:(e\d+)(?::([\w]+))?$/); // element field, optional :ft_text/:ftListValue suffix
    if (el) {
      fields[el[2] ? `${el[1]}:${el[2]}` : el[1]] = v;
      continue;
    }
    const p = k.match(/^param#-#([0-9a-f-]{36})$/i);
    if (p) params[p[1]] = v;
  }
  const ok = json?.status === 'success' || json?.status === true;
  return { ok, status: json?.status, fields, params, messages: json?.messages };
}
