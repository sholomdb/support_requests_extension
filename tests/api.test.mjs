import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildIdLookupRequest,
  parseMappingResponse,
  isAuthFailure,
  API_BASE,
  buildItemSearchRequest,
  buildBudgetSourceRequest,
  buildPushRequest,
  parseIdLookup,
  parseItemSearch,
  parseBudgetSource,
  BIND,
} = await import('../extension/shared/api.js');

const AUTH = { headers: { fturl: 'https://ifcjil.formtitan.com/x', kbgr8jmwl3r1ffbw3nilg: 'a'.repeat(60) } };

describe('buildIdLookupRequest', () => {
  test('builds a get/sfmapping POST with auth headers and the id in the body', async () => {
    const req = await buildIdLookupRequest('052696556', AUTH);
    assert.equal(req.url, `${API_BASE}/get/sfmapping`);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.equal(req.headers.fturl, AUTH.headers.fturl);
    assert.ok(req.headers.kbgr8jmwl3r1ffbw3nilg);
    const body = JSON.parse(req.body);
    assert.equal(body.data.elemUID, 'e2847');
    const item = Object.values(body.data.list)[0];
    assert.equal(item['view:p43#-#p43:e199'], '052696556');
  });

  test('throws a clear error when no auth is available', async () => {
    await assert.rejects(() => buildIdLookupRequest('123', { headers: {} }), /כותרות אימות/);
  });
});

describe('parseMappingResponse', () => {
  test('extracts element fields, params and success status', () => {
    const sample = JSON.stringify({
      status: 'success',
      data: {
        'view:p43#-#p43:e229:ft_text': 'מודיעין עילית',
        'view:p43#-#p43:e213': 5,
        'view:p43#-#p43:e229:ft_value': 'a08D000000dOJp0IAG',
        'param#-#ce55f641-1565-448e-9272-5fb51968a0fc': '001N20000032rZZIAY',
      },
      messages: {},
    });
    const r = parseMappingResponse(sample);
    assert.equal(r.ok, true);
    assert.equal(r.fields['e229:ft_text'], 'מודיעין עילית');
    assert.equal(r.fields['e213'], 5);
    assert.equal(r.fields['e229:ft_value'], 'a08D000000dOJp0IAG');
    assert.equal(r.params['ce55f641-1565-448e-9272-5fb51968a0fc'], '001N20000032rZZIAY');
  });

  test('non-JSON response is flagged not-ok with a raw snippet', () => {
    const r = parseMappingResponse('<html>error</html>');
    assert.equal(r.ok, false);
    assert.ok(r.raw.includes('error'));
  });
});

describe('buildItemSearchRequest', () => {
  test('sends item text + budget label + the allow child params', async () => {
    const req = await buildItemSearchRequest('מזון', 'סיוע חירום למשפחות', { auth: AUTH });
    const b = JSON.parse(req.body);
    assert.equal(b.data.elemUID, 'e421');
    assert.equal(b.data.ruleUID, BIND.itemSearchRule);
    const item = Object.values(b.data.list)[0];
    assert.equal(item['view:p239#-#p239:e421'], 'מזון');
    assert.equal(item['view:p239#-#p239:e687:ftListValue'], 'סיוע חירום למשפחות');
    const child = Object.values(item.childrens.list)[0];
    assert.equal(child[`param#-#${BIND.paramBudgetLabel}`], 'סיוע חירום למשפחות');
    assert.equal(child[`param#-#${BIND.paramItemAllow}`], 'true');
  });
});

describe('buildBudgetSourceRequest', () => {
  test('sends account id, date and budget label with ruleUID action', async () => {
    const req = await buildBudgetSourceRequest(
      { accountId: 'a123z0', dateISO: '2026-07-19', budgetLabel: 'סיוע חירום למשפחות' },
      { auth: AUTH },
    );
    const b = JSON.parse(req.body);
    assert.equal(b.data.elemUID, 'e424');
    assert.equal(b.data.ruleUID, 'action');
    const row = Object.values(b.data.list)[0];
    assert.equal(row[`param#-#${BIND.paramAccountId}`], 'a123z0');
    assert.equal(row[`param#-#${BIND.paramDate}`], '2026-07-19');
    assert.equal(row[`param#-#${BIND.paramBudgetLabel}`], 'סיוע חירום למשפחות');
  });
});

describe('buildPushRequest', () => {
  test('produces a multipart form (no Content-Type) with state serialized', () => {
    const req = buildPushRequest({ elemUID: 'e238', actionRuleId: 'A', nodeId: 'N', state: { k: 1 } }, AUTH);
    assert.ok(req.url.endsWith('/push/sfmapping'));
    assert.equal(req.form.elemUID, 'e238');
    assert.equal(req.form.actionRuleId, 'A');
    assert.equal(req.form.nodeId, 'N');
    assert.deepEqual(JSON.parse(req.form.state), { k: 1 });
    assert.ok(!('Content-Type' in req.headers));
    assert.ok('body' in req === false);
  });
});

describe('structural id parsers', () => {
  test('parseIdLookup pulls the contact id (001…) from params', () => {
    const text = JSON.stringify({
      status: 'success',
      data: { 'param#-#ce55f641-1565-448e-9272-5fb51968a0fc': '001N2000011m4eoIAA', 'view:p43#-#p43:e200': 'כהן' },
    });
    assert.equal(parseIdLookup(text).contactId, '001N2000011m4eoIAA');
  });

  test('parseItemSearch pulls the item id (a10…) and price cap', () => {
    const text = JSON.stringify({
      status: 'success',
      data: {
        'view:p239#-#p239:s287:a10e5c5c-cb76-4d2f-923f-b7e6dc3c35a5': 'a103z00000FcPbKAAV',
        'view:p239#-#p239:s287:e296:TYPO_TEXT': 5000,
        'view:p239#-#p239:s287:c87a2da3': 'a3k3z000002hmkTAAQ',
      },
    });
    const r = parseItemSearch(text);
    assert.equal(r.itemId, 'a103z00000FcPbKAAV');
    assert.equal(r.priceCap, 5000);
  });

  test('parseBudgetSource pulls source id (a3V…), remaining and record id (a0R…)', () => {
    const text = JSON.stringify({
      status: 'success',
      data: {
        'view:e424#-#p298:e424:value': 'a3VN2000002ZxAaMAK',
        'view:e424#-#p298:e424:g1': 216747,
        'view:e424#-#p298:e424:g2': 'a0RN200000HJTSj',
      },
    });
    const r = parseBudgetSource(text);
    assert.equal(r.sourceId, 'a3VN2000002ZxAaMAK');
    assert.equal(r.remaining, 216747);
    assert.equal(r.recordId, 'a0RN200000HJTSj');
  });
});

describe('isAuthFailure', () => {
  test('non-2xx and login pages are auth failures', () => {
    assert.equal(isAuthFailure(401, '{}'), true);
    assert.equal(isAuthFailure(302, ''), true);
    assert.equal(isAuthFailure(200, '<html>please login</html>'), true);
    assert.equal(isAuthFailure(200, '{"type":"sfsmartv"}'), true);
  });
  test('a normal 200 sfmapping response is not an auth failure', () => {
    assert.equal(isAuthFailure(200, '{"status":"success","data":{}}'), false);
  });
});
