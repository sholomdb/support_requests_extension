import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { buildIdLookupRequest, parseMappingResponse, isAuthFailure, API_BASE } = await import('../extension/shared/api.js');

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
