import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { assembleMutavState, toStateKey } = await import('../extension/shared/state-assembler.js');

// The id-lookup response `data`, in its `#-#` form (person fields + a contact param + noise
// that must NOT flow into the push: a pageParam, a TYPO_TEXT display value, another page's field).
const LOOKUP = {
  'view:p43#-#p43:e200': 'כהן',
  'view:p43#-#p43:e213': 10,
  'view:p43#-#p43:e229:ft_text': 'מודיעין עילית',
  'param#-#ce55f641-1565-448e-9272-5fb51968a0fc': '001N2000011m4eoIAA',
  'view:p43#-#p43:e2815:TYPO_TEXT': 1500, // display-only, drop
  'pageParam#-#p43:abc': false, // page param, drop
  'view:p298#-#p298:e310:TYPO_TEXT': 1500, // other page, drop
};

describe('toStateKey', () => {
  test('swaps the read separator for the push separator', () => {
    assert.equal(toStateKey('view:p43#-#p43:e200'), 'view:p43##p43:e200');
    assert.equal(toStateKey('param#-#guid'), 'param##guid');
  });
});

describe('assembleMutavState', () => {
  test('carries person fields + params, drops TYPO/pageParam/other-page keys', () => {
    const s = assembleMutavState(LOOKUP);
    assert.equal(s['view:p43##p43:e200'], 'כהן');
    assert.equal(s['view:p43##p43:e213'], 10);
    assert.equal(s['view:p43##p43:e229:ft_text'], 'מודיעין עילית');
    assert.equal(s['param##ce55f641-1565-448e-9272-5fb51968a0fc'], '001N2000011m4eoIAA');
    assert.equal(s['smartv##id'], '');
    assert.ok(!('view:p43##p43:e2815:TYPO_TEXT' in s));
    assert.ok(!('pageParam##p43:abc' in s));
    assert.ok(!('view:p298##p298:e310:TYPO_TEXT' in s));
  });

  test('overrides win over lookup values', () => {
    const s = assembleMutavState(LOOKUP, {
      'view:p43##p43:e200': 'לוי',
      'view:p43##p43:e199': '313063935',
    });
    assert.equal(s['view:p43##p43:e200'], 'לוי'); // replaced
    assert.equal(s['view:p43##p43:e199'], '313063935'); // added
  });
});
