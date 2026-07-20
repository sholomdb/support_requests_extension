import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers/chrome-stub.mjs';

installChromeStub();
const { runRequest, discoverSchemas, AUTH_ERROR } = await import('../extension/shared/ft-flow.js');

const AUTH = { headers: { fturl: 'x', tok: 'y' } };

// Minimal preview-page with an sfAction rule redirecting to the form's next page.
function previewPage(redirect) {
  return JSON.stringify({
    pages: {
      p: {
        e1: { uid: 'e199', group: 'view:p43', label: 'ת.ז.' },
        rules: [
          {
            uid: 'ruleA',
            actions: { actionFlow: { 0: { list: [{ id: 'nodeA', type: 'sfAction' }, { id: 'r', type: 'redirect', data: { redirect: { value: redirect, type: 'page' } } }] } } },
          },
        ],
      },
    },
  });
}

// A fetchApi stub that dispatches on url/elem and records what it was called with.
function makeFetch() {
  const calls = [];
  const fetchApi = async (req) => {
    calls.push(req);
    const url = req.url;
    if (url.includes('preview-page/MUTAV')) return { ok: true, status: 200, text: previewPage('p239') };
    if (url.includes('preview-page/WhoHowM')) return { ok: true, status: 200, text: previewPage('p2') };
    if (url.includes('push/sfmapping')) return { ok: true, status: 200, text: '{"status":true,"data":{}}' };
    const body = JSON.parse(req.body);
    const elem = body.data.elemUID;
    if (elem === 'e2847') return { ok: true, status: 200, text: JSON.stringify({ status: 'success', data: { 'param#-#ce55f641-1565-448e-9272-5fb51968a0fc': '001N222', 'view:p43#-#p43:e200': 'כהן' } }) };
    if (elem === 'e421') return { ok: true, status: 200, text: JSON.stringify({ status: 'success', data: { 'view:p239#-#p239:s287:a10x': 'a103ITEM', 'view:p239#-#p239:s287:e296:TYPO_TEXT': 5000 } }) };
    if (elem === 'e424') return { ok: true, status: 200, text: JSON.stringify({ status: 'success', data: { 'view:e424#-#p298:e424:value': 'a3VSRC', 'view:e424#-#p298:e424:g1': 216747, 'view:e424#-#p298:e424:g2': 'a0RREC' } }) };
    return { ok: true, status: 200, text: '{"status":"success","data":{}}' };
  };
  return { fetchApi, calls };
}

const REQUEST = {
  fields: { idNumber: '313063935', familyClassification: 'משפחה עם זוג הורים', itemSiteValue: 'מזון', budgetSiteValue: 'סיוע חירום למשפחות' },
};

describe('discoverSchemas', () => {
  test('fetches both push forms once and caches on ctx', async () => {
    const { fetchApi, calls } = makeFetch();
    const ctx = {};
    await discoverSchemas(fetchApi, AUTH, ctx);
    assert.equal(ctx.schemas.MUTAV.pushRule.actionRuleId, 'ruleA');
    assert.equal(ctx.schemas.MUTAV.pushRule.nodeId, 'nodeA');
    const before = calls.length;
    await discoverSchemas(fetchApi, AUTH, ctx); // cached - no more calls
    assert.equal(calls.length, before);
  });
});

describe('runRequest (dry run)', () => {
  test('resolves the full id chain from the reads', async () => {
    const { fetchApi } = makeFetch();
    const ctx = { accountId: 'a123ACC', dateISO: '2026-07-19' };
    const trace = await runRequest(REQUEST, { fetchApi, auth: AUTH, ctx });
    assert.equal(trace.ids.contactId, '001N222');
    assert.equal(trace.ids.itemId, 'a103ITEM');
    assert.equal(trace.ids.priceCap, 5000);
    assert.equal(trace.ids.sourceId, 'a3VSRC');
    assert.equal(trace.ids.remaining, 216747);
    assert.equal(trace.ids.recordId, 'a0RREC');
  });

  test('does NOT push anything by default and builds the MUTAV push for inspection', async () => {
    const { fetchApi, calls } = makeFetch();
    const ctx = { accountId: 'a123ACC', dateISO: '2026-07-19' };
    const trace = await runRequest(REQUEST, { fetchApi, auth: AUTH, ctx });
    assert.equal(trace.pushed.mutav, false);
    assert.ok(!calls.some((c) => c.url.includes('push/sfmapping')));
    // the built (unsent) push carries our overrides
    const state = JSON.parse(trace.requests.mutavPush.form.state);
    assert.equal(state['view:p43##p43:e199'], '313063935');
    assert.equal(state['view:p43##p43:e218:ftListValue'], 'משפחה עם זוג הורים');
    assert.equal(state['param##ec14481b-095b-44b8-875c-69e87aa34b2f'], 'a123ACC');
  });

  test('opts.pushMutav sends the first-stage push', async () => {
    const { fetchApi, calls } = makeFetch();
    const ctx = { accountId: 'a123ACC', dateISO: '2026-07-19' };
    const trace = await runRequest(REQUEST, { fetchApi, auth: AUTH, ctx, opts: { pushMutav: true } });
    assert.equal(trace.pushed.mutav, true);
    assert.ok(calls.some((c) => c.url.includes('push/sfmapping')));
  });

  test('an auth failure surfaces as an AUTH-coded error', async () => {
    const fetchApi = async (req) => {
      if (req.url.includes('preview-page')) return { ok: true, status: 200, text: previewPage('p239') };
      return { ok: true, status: 200, text: '{"type":"sfsmartv"}' };
    };
    await assert.rejects(() => runRequest(REQUEST, { fetchApi, auth: AUTH, ctx: {} }), (e) => e.code === AUTH_ERROR);
  });
});
