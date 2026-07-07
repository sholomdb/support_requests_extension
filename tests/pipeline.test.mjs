import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers/chrome-stub.mjs';

installChromeStub();
const {
  ROW_STATUS,
  fileIdOf,
  rowKeyOf,
  buildRow,
  buildRequests,
  buildAllRequests,
  splitAmount,
  collectMappingQueue,
  mergeRowsOnReupload,
  mergeRequestsOnReupload,
} = await import('../extension/shared/pipeline.js');
const { MAP_TYPES, mappingKey, saveMapping } = await import('../extension/shared/mappings.js');
const { catalogMaxPrice } = await import('../extension/shared/catalog-data.js');

const FILE_ID = fileIdOf('beytar.xlsx');

function makeRawRow(overrides = {}) {
  return {
    rowIndex: 0,
    excelRow: 7,
    budgetType: 'משפחות',
    city: 'אלעד',
    idNumber: '123456782',
    lastName: 'כהן',
    firstName: 'דוד',
    gender: 'זכר',
    sector: 'יהודי',
    maritalStatus: 'נשוי/אה',
    householdSize: '4',
    birthCountry: 'ישראל',
    birthDate: '05/03/1985',
    holocaustSurvivor: 'לא',
    phone: '0501234567',
    street: 'הרצל',
    building: '10',
    settlement: '',
    item: 'מקרר',
    itemCategory: '',
    amount: 500,
    justification: 'נזקק לסיוע',
    cardNumber1: '',
    ...overrides,
  };
}

function resolvedEntry(type, excelValue, context, entry) {
  return [`${type}::${mappingKey(type, excelValue, context)}`, entry];
}

/** A resolvedMap with every mapType field already answered - the state buildRow()
 * expects to receive after collectMappingQueue() + operator prompts have run. */
function fullyResolvedMap(raw) {
  return new Map([
    resolvedEntry(MAP_TYPES.city, raw.city, { city: raw.city }, { siteValue: raw.city }),
    resolvedEntry(MAP_TYPES.birthCountry, raw.birthCountry, {}, { siteValue: raw.birthCountry }),
    resolvedEntry(
      MAP_TYPES.familyClassification,
      `${raw.householdSize}::${raw.maritalStatus}`,
      { householdSize: raw.householdSize, maritalStatus: raw.maritalStatus },
      { siteValue: 'משפחה עם זוג הורים' }
    ),
    resolvedEntry(MAP_TYPES.budgetType, raw.budgetType, {}, { siteValue: 'סיוע חירום למשפחות', labelIndex: 1 }),
    resolvedEntry(MAP_TYPES.item, raw.item, {}, { siteValue: raw.item, selector: '#item1' }),
    resolvedEntry(
      MAP_TYPES.budgetSource,
      `${raw.budgetType}::${raw.city}`,
      { budgetType: raw.budgetType, city: raw.city },
      { siteValue: 'מקור תקציב לדוגמה' }
    ),
  ]);
}

describe('fileIdOf / rowKeyOf', () => {
  test('is stable for the same file name regardless of case/whitespace', () => {
    assert.equal(fileIdOf('Beytar.xlsx'), fileIdOf('  beytar.xlsx  '));
  });
  test('rowKey is scoped to fileId + idNumber + excelRow', () => {
    const raw = makeRawRow();
    assert.equal(rowKeyOf(FILE_ID, raw), `${FILE_ID}::${raw.idNumber}::${raw.excelRow}`);
  });
  test('a different file id produces a different rowKey for the same row data', () => {
    const raw = makeRawRow();
    assert.notEqual(rowKeyOf(FILE_ID, raw), rowKeyOf(fileIdOf('elad.xlsx'), raw));
  });
});

describe('buildRow', () => {
  test('a fully valid, fully resolved row is READY with no errors', () => {
    const raw = makeRawRow();
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.status, ROW_STATUS.READY);
    assert.deepEqual(row.errors, []);
  });

  test('mapType fields are unwrapped to their plain site value, not the raw mapping entry', () => {
    // Regression test: defaultOutputAs used to leak the {siteValue,labelIndex,selector}
    // entry object straight into fields for mapType fields with no custom outputAs.
    const raw = makeRawRow();
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.citySearch, raw.city);
    assert.equal(typeof row.fields.citySearch, 'string');
    assert.equal(row.fields.birthCountry, raw.birthCountry);
    assert.equal(row.fields.familyClassification, 'משפחה עם זוג הורים');
  });

  test('budgetType/item/budgetSource unpack into their content.js-facing field names', () => {
    const raw = makeRawRow();
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.budgetLabelIndex, 1);
    assert.equal(row.fields.budgetSiteValue, 'סיוע חירום למשפחות');
    assert.equal(row.fields.itemSelector, '#item1');
    assert.equal(row.fields.itemSiteValue, raw.item);
    assert.equal(row.fields.budgetSourceSearch, 'מקור תקציב לדוגמה');
  });

  test('an unresolved categorical field marks the row needs-mapping, not just invalid', () => {
    const raw = makeRawRow();
    const map = fullyResolvedMap(raw);
    map.delete(`${MAP_TYPES.item}::${mappingKey(MAP_TYPES.item, raw.item)}`);
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.NEEDS_MAPPING);
    assert.ok(row.errors.some((e) => e.field === 'item'));
  });

  test('a short id number gets padded and is valid', () => {
    // normalizeIdNumber pads short ids to 9 digits - this is the "fix" phase, not
    // a validation failure, as long as the padded result is 9 digits.
    const raw = makeRawRow({ idNumber: '123' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.idNumber, '000000123');
    assert.ok(!row.errors.some((e) => e.field === 'idNumber'));
  });

  test('an id number longer than 9 digits is invalid', () => {
    const raw = makeRawRow({ idNumber: '12345678901' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'idNumber'));
  });

  test('a missing id number is invalid', () => {
    const raw = makeRawRow({ idNumber: '' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'idNumber'));
  });

  test('a missing required text field is invalid', () => {
    const raw = makeRawRow({ lastName: '' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'lastName'));
  });

  test('a non-positive amount is invalid', () => {
    const raw = makeRawRow({ amount: 0 });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'amount'));
  });

  test('מטה בנימין requires a settlement value', () => {
    const raw = makeRawRow({ city: 'מטה בנימין', settlement: '' });
    const map = fullyResolvedMap(raw);
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'settlement'));
    assert.equal(row.fields.needsSettlement, true);
  });

  test('non-מטה בנימין rows do not require settlement and needsSettlement is false', () => {
    const raw = makeRawRow();
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.needsSettlement, false);
    assert.ok(!row.errors.some((e) => e.field === 'settlement'));
  });

  const setFamily = (map, raw, siteValue) => {
    const [k, v] = resolvedEntry(
      MAP_TYPES.familyClassification,
      `${raw.householdSize}::${raw.maritalStatus}`,
      { householdSize: raw.householdSize, maritalStatus: raw.maritalStatus },
      { siteValue }
    );
    map.set(k, v);
  };

  test('"זוג ללא ילדים" for a married couple of 2 is valid', () => {
    const raw = makeRawRow({ maritalStatus: 'נשוי/אה', householdSize: '2' });
    const map = fullyResolvedMap(raw);
    setFamily(map, raw, 'זוג ללא ילדים');
    const row = buildRow(raw, map, FILE_ID);
    assert.ok(!row.errors.some((e) => e.field === 'familyClassification'));
  });

  test('"זוג ללא ילדים" for a single person / size != 2 is INVALID', () => {
    const raw = makeRawRow({ maritalStatus: 'רווק/ה', householdSize: '5' });
    const map = fullyResolvedMap(raw);
    setFamily(map, raw, 'זוג ללא ילדים');
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'familyClassification'));
  });

  test('"זוג ללא ילדים" for a married couple but size 4 is INVALID', () => {
    const raw = makeRawRow({ maritalStatus: 'נשוי/אה', householdSize: '4' });
    const map = fullyResolvedMap(raw);
    setFamily(map, raw, 'זוג ללא ילדים');
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'familyClassification'));
  });

  test('a 05-prefixed 10-digit phone routes to mobilePhone', () => {
    const raw = makeRawRow({ phone: '0501234567' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.mobilePhone, '0501234567');
    assert.equal(row.fields.homePhone, undefined);
  });

  test('a landline routes to homePhone padded to 9 digits (not 10)', () => {
    const raw = makeRawRow({ phone: '21234567' });
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.fields.homePhone, '021234567');
    assert.equal(row.fields.mobilePhone, undefined);
  });

  test('rowKey is present and matches rowKeyOf', () => {
    const raw = makeRawRow();
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    assert.equal(row.rowKey, rowKeyOf(FILE_ID, raw));
  });
});

describe('splitAmount', () => {
  test('within limit -> single chunk', () => {
    assert.deepEqual(splitAmount(500, 4500), [500]);
  });
  test('over limit -> chunks of at most limit, remainder last', () => {
    assert.deepEqual(splitAmount(900, 500), [500, 400]);
    assert.deepEqual(splitAmount(900, 400), [400, 400, 100]);
  });
  test('no/zero limit -> single chunk (no split)', () => {
    assert.deepEqual(splitAmount(900, null), [900]);
    assert.deepEqual(splitAmount(900, 0), [900]);
  });
});

describe('buildRequests (split by item max price)', () => {
  test('a within-limit row produces one request', () => {
    const raw = makeRawRow({ item: 'מקרר', amount: 500 }); // מקרר limit in חירום = 4500
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    const requests = buildRequests(row);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requestId, `${row.rowKey}::0`);
    assert.equal(requests[0].fields.amount, '500');
    assert.deepEqual(requests[0].steps, { 1: 'pending', 2: 'pending', 3: 'pending' });
  });

  test('an over-limit row splits into 500 + 400, ids ::0 and ::1, other fields identical', () => {
    // בלנדר limit in חירום = 400... use an item with a 500 limit for the example.
    const raw = makeRawRow({ item: 'גלאי עשן', amount: 900 }); // גלאי עשן limit = 500
    assert.equal(catalogMaxPrice('סיוע חירום למשפחות', 'גלאי עשן'), 500);
    const row = buildRow(raw, fullyResolvedMap(raw), FILE_ID);
    const requests = buildRequests(row);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((r) => r.fields.amount), ['500', '400']);
    assert.deepEqual(requests.map((r) => r.requestId), [`${row.rowKey}::0`, `${row.rowKey}::1`]);
    // everything except amount is identical
    assert.equal(requests[0].fields.idNumber, requests[1].fields.idNumber);
    assert.equal(requests[0].fields.itemSiteValue, requests[1].fields.itemSiteValue);
    assert.equal(requests[1].splitIndex, 1);
    assert.equal(requests[1].splitCount, 2);
  });

  test('split requestIds are stable across a re-parse of the same file (re-upload identity)', () => {
    const raw = makeRawRow({ item: 'גלאי עשן', amount: 900 });
    const idsA = buildRequests(buildRow(raw, fullyResolvedMap(raw), FILE_ID)).map((r) => r.requestId);
    const idsB = buildRequests(buildRow(raw, fullyResolvedMap(raw), FILE_ID)).map((r) => r.requestId);
    assert.deepEqual(idsA, idsB);
  });
});

describe('buildAllRequests (overflow appended at the end)', () => {
  test('primary chunks keep row order; overflow chunks go last', () => {
    const a = makeRawRow({ idNumber: '111111118', excelRow: 7, item: 'מקרר', amount: 500 }); // no split
    const b = makeRawRow({ idNumber: '222222226', excelRow: 8, item: 'גלאי עשן', amount: 900 }); // splits 500+400
    const rows = [a, b].map((r) => buildRow(r, fullyResolvedMap(r), FILE_ID));
    const all = buildAllRequests(rows);
    // primaries first (a::0, b::0), then overflow (b::1)
    assert.deepEqual(all.map((r) => r.requestId.split('::').pop()), ['0', '0', '1']);
    assert.equal(all[2].fields.amount, '400');
  });
});

describe('mergeRowsOnReupload', () => {
  test('keeps new rows and reports how many old rows disappeared', () => {
    const rawA = makeRawRow({ idNumber: '111111118', excelRow: 7 });
    const rawB = makeRawRow({ idNumber: '222222226', excelRow: 8 });
    const rawC = makeRawRow({ idNumber: '333333334', excelRow: 9 });

    const oldRows = [rawA, rawB].map((r) => buildRow(r, fullyResolvedMap(r), FILE_ID));
    const newRows = [rawA, rawC].map((r) => buildRow(r, fullyResolvedMap(r), FILE_ID));

    const { rows, droppedCount } = mergeRowsOnReupload(oldRows, newRows);
    assert.equal(rows.length, 2);
    assert.equal(droppedCount, 1); // rawB disappeared
    assert.deepEqual(
      rows.map((r) => r.rowKey).sort(),
      newRows.map((r) => r.rowKey).sort()
    );
  });
});

describe('mergeRequestsOnReupload', () => {
  test('preserves step progress for requests that still exist', () => {
    const existing = [
      { requestId: 'r1', fields: { a: 1 }, steps: { 1: 'filled', 2: 'filled', 3: 'pending' } },
    ];
    const fresh = [
      { requestId: 'r1', fields: { a: 2 }, steps: { 1: 'pending', 2: 'pending', 3: 'pending' } },
      { requestId: 'r2', fields: { a: 3 }, steps: { 1: 'pending', 2: 'pending', 3: 'pending' } },
    ];
    const merged = mergeRequestsOnReupload(existing, fresh);
    const r1 = merged.find((r) => r.requestId === 'r1');
    const r2 = merged.find((r) => r.requestId === 'r2');
    assert.deepEqual(r1.steps, { 1: 'filled', 2: 'filled', 3: 'pending' }); // progress kept
    assert.equal(r1.fields.a, 2); // but fields come from the fresh rebuild
    assert.deepEqual(r2.steps, { 1: 'pending', 2: 'pending', 3: 'pending' }); // brand new
  });
});

describe('item-in-budget validation + catalog max price', () => {
  beforeEach(() => installChromeStub());

  test('a catalog item in its budget resolves with no prompt and gets its per-budget max price', async () => {
    const raw = makeRawRow({ item: 'מזון (סופר,מכולת,ספק מזון)' });
    const { queue, resolved } = await collectMappingQueue([raw], FILE_ID, {});
    assert.ok(!queue.some((q) => q.type === MAP_TYPES.item)); // seeded -> no item prompt
    const row = buildRow(raw, resolved, FILE_ID);
    // No item error, and the per-budget max price is attached.
    assert.ok(!row.errors.some((e) => e.field === 'item'));
    assert.equal(row.fields.itemMaxPrice, catalogMaxPrice('סיוע חירום למשפחות', 'מזון (סופר,מכולת,ספק מזון)'));
  });

  test('an item that does NOT exist in the row budget is INVALID', () => {
    // "מזון..." exists in חירום, but map it under a budget/item combo that does not.
    const raw = makeRawRow({ budgetType: 'משפחות', item: 'פריט מומצא שלא בקטלוג' });
    const map = fullyResolvedMap(raw); // budget -> 'סיוע חירום למשפחות', item -> itself
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'item'));
  });

  test('a real catalog item under a budget that lacks it is INVALID', () => {
    // "אבחון פסיכולוגי לילדים" exists in חירום but NOT in בתי משפט קהילתיים.
    const raw = makeRawRow({ item: 'אבחון פסיכולוגי לילדים' });
    const map = fullyResolvedMap(raw);
    map.set(`${MAP_TYPES.budgetType}::${mappingKey(MAP_TYPES.budgetType, raw.budgetType)}`, {
      siteValue: 'בתי משפט קהילתיים',
      labelIndex: 4,
    });
    const row = buildRow(raw, map, FILE_ID);
    assert.equal(row.status, ROW_STATUS.INVALID);
    assert.ok(row.errors.some((e) => e.field === 'item'));
  });
});

describe('collectMappingQueue', () => {
  beforeEach(() => installChromeStub());

  test('asks about a shared unmapped value only once, across every affected row', async () => {
    const rows = [
      makeRawRow({ idNumber: '111111118', excelRow: 7, item: 'פריט חדש' }),
      makeRawRow({ idNumber: '222222226', excelRow: 8, item: 'פריט חדש' }),
      makeRawRow({ idNumber: '333333334', excelRow: 9, item: 'פריט חדש' }),
    ];
    const { queue } = await collectMappingQueue(rows, FILE_ID, {});
    const itemEntries = queue.filter((q) => q.type === MAP_TYPES.item);
    assert.equal(itemEntries.length, 1);
    assert.equal(itemEntries[0].affectedRowKeys.length, 3);
  });

  test('a value already resolvable via a seed does not appear in the queue', async () => {
    const rows = [makeRawRow({ city: 'אלעד' })];
    const { queue, resolved } = await collectMappingQueue(rows, FILE_ID, {});
    assert.ok(!queue.some((q) => q.type === MAP_TYPES.city));
    assert.ok(resolved.has(`${MAP_TYPES.city}::${mappingKey(MAP_TYPES.city, 'אלעד')}`));
  });

  test('once an operator saves a mapping, the same value resolves on the next scan', async () => {
    const raw = makeRawRow({ item: 'מקרר חדש' });
    let result = await collectMappingQueue([raw], FILE_ID, {});
    assert.ok(result.queue.some((q) => q.type === MAP_TYPES.item));

    await saveMapping(MAP_TYPES.item, 'מקרר חדש', '#e999');

    result = await collectMappingQueue([raw], FILE_ID, {});
    assert.ok(!result.queue.some((q) => q.type === MAP_TYPES.item));
  });
});
