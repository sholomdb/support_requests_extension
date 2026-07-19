import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { buildSmsRequest, buildVerifyRequest, parseVerifyResponse, SESSION_HEADERS, HOME_URL } = await import(
  '../extension/shared/ft-login.js'
);

describe('buildSmsRequest (step: email)', () => {
  test('posts credentials with step "email" and the fturl header', () => {
    const req = buildSmsRequest('063203442', 'secret');
    assert.ok(req.url.endsWith('/webprojects/smart-v/request'));
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.fturl, HOME_URL);
    const body = JSON.parse(req.body);
    assert.equal(body.step, 'email');
    assert.equal(body.type, 'sfsmartv');
    assert.equal(body.credentials.Id_no__c, '063203442');
    assert.equal(body.credentials.Personal_password__c, 'secret');
  });
});

describe('buildVerifyRequest (step: code)', () => {
  test('includes the SMS code as password and step "code"', () => {
    const body = JSON.parse(buildVerifyRequest('063203442', 'secret', '1234').body);
    assert.equal(body.step, 'code');
    assert.equal(body.password, '1234');
    assert.equal(body.credentials.Id_no__c, '063203442');
  });
});

describe('parseVerifyResponse', () => {
  test('maps accessToken/accessSalt onto the session header names', () => {
    const resp = JSON.stringify({
      status: true,
      IsDisable2FA: false,
      accessToken: 'A'.repeat(704),
      accessSalt: 'B'.repeat(704),
    });
    const r = parseVerifyResponse(resp);
    assert.equal(r.ok, true);
    assert.equal(r.auth.headers[SESSION_HEADERS.accessToken], 'A'.repeat(704));
    assert.equal(r.auth.headers[SESSION_HEADERS.accessSalt], 'B'.repeat(704));
    assert.equal(r.auth.headers.fturl, HOME_URL);
    assert.equal(r.auth.via, 'login');
  });

  test('a response without tokens is an error (wrong code / failed login)', () => {
    const r = parseVerifyResponse(JSON.stringify({ status: false, messages: { code: 'invalid' } }));
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test('non-JSON is a clear error', () => {
    const r = parseVerifyResponse('<html>login</html>');
    assert.equal(r.ok, false);
  });
});
