import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// excel-parser.js reads the bundled SheetJS build off the global `XLSX`, exactly
// like the browser does via <script src="lib/xlsx.full.min.js">. The bundle is a
// UMD build that picks its export strategy from `typeof exports`/`module`/`window`
// - under Node's CJS loader (require()) or a vm context those resolve in ways that
// make it populate the wrong target (module.exports of some unrelated module),
// leaving the bundle's own `var XLSX` empty. Loading it via `new Function(...)`
// with exports/module/require/window explicitly shadowed as undefined forces the
// same "plain <script> tag" branch the browser takes, in the *same* realm as the
// rest of this process (unlike a separate vm context, whose distinct ArrayBuffer/
// Uint8Array constructors would make XLSX.read()'s `instanceof` checks fail on
// data created out here).
before(() => {
  const code = readFileSync(path.join(ROOT, 'extension/lib/xlsx.full.min.js'), 'utf8');
  const loadInBrowserLikeScope = new Function(
    'exports',
    'module',
    'require',
    'window',
    `${code}\nreturn (typeof XLSX !== 'undefined') ? XLSX : undefined;`
  );
  globalThis.XLSX = loadInBrowserLikeScope(undefined, undefined, undefined, undefined);
});

const { parseExcelBuffer, COLUMN_MAP } = await import('../extension/shared/excel-parser.js');

function loadSample(name) {
  const buf = readFileSync(path.join(ROOT, name));
  return new Uint8Array(buf).buffer;
}

describe('parseExcelBuffer against the real sample files', () => {
  test('beytar.xlsx parses at least one data row with every mapped column', () => {
    const parsed = parseExcelBuffer(loadSample('beytar.xlsx'), 'beytar.xlsx');
    assert.ok(parsed.rows.length > 0, 'expected at least one row');
    const row = parsed.rows[0];
    for (const field of Object.values(COLUMN_MAP)) {
      assert.ok(field in row, `row is missing column-mapped field "${field}"`);
    }
    assert.ok(row.idNumber, 'first row should have a non-empty idNumber');
    assert.equal(row.idNumber.length, 9, 'idNumber should be padded to 9 digits');
  });

  test('beytar.xlsx totalAmount equals the sum of every row amount', () => {
    const parsed = parseExcelBuffer(loadSample('beytar.xlsx'), 'beytar.xlsx');
    const sum = parsed.rows.reduce((acc, r) => acc + r.amount, 0);
    assert.equal(parsed.totalAmount, sum);
  });

  test('elad.xlsx also parses successfully', () => {
    const parsed = parseExcelBuffer(loadSample('elad.xlsx'), 'elad.xlsx');
    assert.ok(parsed.rows.length > 0);
    assert.ok(parsed.rows.every((r) => typeof r.amount === 'number'));
  });

  test('rows without an idNumber are skipped', () => {
    const parsed = parseExcelBuffer(loadSample('beytar.xlsx'), 'beytar.xlsx');
    assert.ok(parsed.rows.every((r) => r.idNumber && r.idNumber.length > 0));
  });

  test('throws a clear error for a file with no data rows', () => {
    // Build a tiny in-memory workbook with headers but no data rows.
    const wb = globalThis.XLSX.utils.book_new();
    const ws = globalThis.XLSX.utils.aoa_to_sheet([['only', 'headers', 'row', 'six'], [], [], [], [], []]);
    globalThis.XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const out = globalThis.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    assert.throws(() => parseExcelBuffer(out, 'empty.xlsx'), /לא נמצאו שורות נתונים/);
  });
});
