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
