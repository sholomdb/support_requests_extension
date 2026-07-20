/**
 * Runtime form-schema discovery for the request-based (headless) fill.
 *
 * The site's `eNNN` element ids and its rule GUIDs (`actionRuleId`/`nodeId` needed by every
 * push) are reassigned whenever the form is edited, so we never hardcode them. Instead we
 * fetch `GET webprojects/preview-page/{MUTAV|CATALOG|WhoHowM}` once and derive, at runtime:
 *   - label -> {uid, group, subType}  (resolve a logical field to its live eNNN id)
 *   - the push rule (actionRuleId + nodeId) for the form's "next / submit" button.
 *
 * This is the "dry run to figure out the element ids" step: cheap, read-only, cached per
 * form version. If a label lookup later misses we fail loudly ("form changed") rather than
 * guessing. See docs/API_MIGRATION_PLAN.md.
 */
import { getFtAuth } from './ft-auth.js';

export const PREVIEW_BASE = 'https://ifcjil.formtitan.com/webprojects/preview-page';

// The page a form's "next/submit" button redirects to - used to pick the right push rule
// among possibly several sfAction rules on the page.
export const NEXT_PAGE = { MUTAV: 'p239', CATALOG: 'p298', WhoHowM: 'p2' };

/** Builds the GET preview-page request for a form ({url, method, headers}). */
export async function buildPreviewPageRequest(form, auth) {
  auth = auth || (await getFtAuth());
  if (!auth?.headers || !Object.keys(auth.headers).length) {
    throw new Error('לא נלכדו כותרות אימות – פתח או רענן את אתר FormTitan תחילה');
  }
  return { url: `${PREVIEW_BASE}/${form}`, method: 'GET', headers: { ...auth.headers } };
}

/**
 * Parses a preview-page JSON into a usable schema:
 *   { fields: { [label]: {uid, group, subType} }, byUid: { [uid]: label },
 *     actionRules: [ {uid, name, nodeId, redirect} ] }
 * `fields` is keyed by (trimmed) label; when a label repeats across render contexts the last
 * seen wins - callers resolve by exact label from a small maintained table.
 */
export function parsePreviewPage(json) {
  const fields = {};
  const byUid = {};
  const actionRules = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.uid === 'string' && /^e\d+$/.test(o.uid) && o.group) {
      const label = (o.label || '').trim();
      if (label) {
        fields[label] = { uid: o.uid, group: o.group, subType: o.subType };
        byUid[o.uid] = label;
      }
    }
    if (typeof o.uid === 'string' && o.actions && o.actions.actionFlow) {
      const sfNodes = [];
      for (const step of Object.values(o.actions.actionFlow)) {
        for (const it of step.list || []) if (it.type === 'sfAction') sfNodes.push(it.id);
      }
      if (sfNodes.length) {
        const s = JSON.stringify(o.actions);
        const rm = s.match(/"value":"(p\d+)","type":"page"/) || s.match(/"type":"page","ftMode":"[^"]*","label":"[^"]*","value":"(p\d+)"/) || s.match(/"redirect":\{[^}]*"value":"(p\d+)"/);
        actionRules.push({ uid: o.uid, name: o.name || '', nodeId: sfNodes[0], redirect: rm ? rm[1] : '' });
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(json?.pages ?? json);
  return { fields, byUid, actionRules };
}

/**
 * Picks the push rule (actionRuleId + nodeId) for a form: the sfAction rule whose redirect
 * targets the form's known next page. Falls back to the only sfAction rule if the redirect
 * can't be matched, and throws if none exists (form changed / wrong page).
 */
export function findPushRule(schema, form) {
  const rules = schema?.actionRules || [];
  if (!rules.length) throw new Error(`לא נמצא כלל שליחה (sfAction) בטופס ${form} – ייתכן שהטופס השתנה`);
  const next = NEXT_PAGE[form];
  const byRedirect = rules.find((r) => next && r.redirect === next);
  const chosen = byRedirect || (rules.length === 1 ? rules[0] : null);
  if (!chosen) {
    throw new Error(`יש כמה כללי שליחה בטופס ${form} ואף אחד לא מפנה ל-${next} – עדכן NEXT_PAGE`);
  }
  return { actionRuleId: chosen.uid, nodeId: chosen.nodeId };
}

/** Resolves a logical field's live eNNN uid from the schema by its exact label. Throws
 * loudly if the label is gone (the form changed and the label table needs updating). */
export function resolveUid(schema, label) {
  const f = schema?.fields?.[label];
  if (!f) throw new Error(`שדה "${label}" לא נמצא בהגדרת הטופס – ייתכן שהטופס השתנה`);
  return f.uid;
}
