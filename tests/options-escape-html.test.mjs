import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers/chrome-stub.mjs';

// options.js's init() is guarded to only run when `document` exists, so this
// import is safe in plain Node - see extension/options/options.js bottom.
installChromeStub();
const { escapeHtml } = await import('../extension/options/options.js');

describe('escapeHtml', () => {
  test('regression: a value containing a literal double quote does not get cut off', () => {
    // Real Hebrew abbreviations (גרשיים) like these were the actual reported bug:
    // building `value="${v}"` with an unescaped `"` truncated the attribute mid-string.
    const value = 'של"מ';
    const escaped = escapeHtml(value);
    assert.equal(escaped, 'של&quot;מ');

    const html = `<input value="${escaped}" />`;
    // Simulate what an HTML attribute parser sees: it stops at the first *unescaped*
    // quote. With proper escaping that's only the closing one, and the full original
    // text is recoverable after entity-decoding.
    const match = html.match(/value="([^"]*)"/);
    assert.ok(match, 'the attribute must still parse as one complete value="..." token');
    assert.equal(match[1].replace(/&quot;/g, '"'), value);
  });

  test('escapes another real example with two quotes', () => {
    const escaped = escapeHtml('אש"ל חב"ד ירושלים');
    assert.equal(escaped, 'אש&quot;ל חב&quot;ד ירושלים');
  });

  test('escapes & and angle brackets', () => {
    assert.equal(escapeHtml('A & B <script>'), 'A &amp; B &lt;script&gt;');
  });

  test('handles null/undefined safely', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('leaves plain text untouched', () => {
    assert.equal(escapeHtml('אלעד'), 'אלעד');
  });
});
