import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers/chrome-stub.mjs';

installChromeStub();
const { parsePreviewPage, findPushRule, resolveUid, buildPreviewPageRequest, NEXT_PAGE } = await import(
  '../extension/shared/form-schema.js'
);

// A compact preview-page shaped like the real one: a `pages` tree with FormField nodes
// (uid=eNNN + group + label) and rule nodes (uid=guid + actions.actionFlow with sfAction nodes
// and a page redirect).
const PREVIEW = {
  status: 'success',
  pages: {
    p43: {
      elements: {
        e199: { uid: 'e199', group: 'view:p43', label: 'מספר זהוי פרטני', subType: 'text' },
        e213: { uid: 'e213', group: 'view:p43', label: 'נפשות', subType: 'number' },
      },
      rules: [
        {
          uid: 'rule-decoy',
          actions: { actionFlow: { 0: { list: [{ id: 'n0', type: 'input' }] } } },
        },
        {
          uid: '4316add2-2a30-4503-bacc-c09eb7685744',
          name: 'מעבר לעמוד הבא',
          actions: {
            actionFlow: {
              0: {
                list: [
                  { id: 'fd5ea8e4-d07f-4c42-8c7c-005076dacaf4', type: 'sfAction' },
                  { id: 'x', type: 'redirect', data: { redirect: { value: 'p239', type: 'page' } } },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

describe('parsePreviewPage', () => {
  test('maps labels to eNNN uids and collects sfAction rules', () => {
    const s = parsePreviewPage(PREVIEW);
    assert.equal(s.fields['מספר זהוי פרטני'].uid, 'e199');
    assert.equal(s.fields['נפשות'].uid, 'e213');
    assert.equal(s.byUid['e199'], 'מספר זהוי פרטני');
    // only the rule containing an sfAction node is kept
    assert.equal(s.actionRules.length, 1);
    assert.equal(s.actionRules[0].uid, '4316add2-2a30-4503-bacc-c09eb7685744');
    assert.equal(s.actionRules[0].nodeId, 'fd5ea8e4-d07f-4c42-8c7c-005076dacaf4');
    assert.equal(s.actionRules[0].redirect, 'p239');
  });
});

describe('findPushRule', () => {
  test('picks the sfAction rule whose redirect targets the next page', () => {
    const s = parsePreviewPage(PREVIEW);
    const rule = findPushRule(s, 'MUTAV');
    assert.equal(rule.actionRuleId, '4316add2-2a30-4503-bacc-c09eb7685744');
    assert.equal(rule.nodeId, 'fd5ea8e4-d07f-4c42-8c7c-005076dacaf4');
  });

  test('throws when the form has no push rule', () => {
    assert.throws(() => findPushRule({ actionRules: [] }, 'MUTAV'), /לא נמצא כלל שליחה/);
  });
});

describe('resolveUid', () => {
  test('resolves by exact label and fails loudly when missing', () => {
    const s = parsePreviewPage(PREVIEW);
    assert.equal(resolveUid(s, 'נפשות'), 'e213');
    assert.throws(() => resolveUid(s, 'שדה שלא קיים'), /לא נמצא בהגדרת הטופס/);
  });
});

describe('buildPreviewPageRequest', () => {
  test('builds a GET with auth headers to the right form url', async () => {
    const req = await buildPreviewPageRequest('MUTAV', { headers: { fturl: 'x', tok: 'y' } });
    assert.equal(req.method, 'GET');
    assert.ok(req.url.endsWith('/preview-page/MUTAV'));
    assert.equal(req.headers.fturl, 'x');
  });

  test('NEXT_PAGE covers the three forms', () => {
    assert.deepEqual(Object.keys(NEXT_PAGE).sort(), ['CATALOG', 'MUTAV', 'WhoHowM']);
  });
});
