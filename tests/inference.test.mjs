import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferFamilyClassification,
  inferBirthCountry,
  routePhone,
  normalizeHolocaust,
} from '../extension/shared/inference.js';

describe('inferFamilyClassification', () => {
  test('household of 1 is בודד', () => {
    assert.equal(inferFamilyClassification(1, 'רווק/ה').value, 'בודד');
  });
  test('married couple of 2 with no kids', () => {
    assert.equal(inferFamilyClassification(2, 'נשוי/אה').value, 'זוג ללא ילדים');
  });
  test('single parent with 3+ household is הורה עצמאי', () => {
    assert.equal(inferFamilyClassification(3, 'גרוש/ה').value, 'משפחה עם הורה עצמאי  (חד הוריות)');
  });
  test('single (רווק/ה) with a multi-person household is treated as single-parent', () => {
    assert.equal(inferFamilyClassification(5, 'רווק/ה').value, 'משפחה עם הורה עצמאי  (חד הוריות)');
    assert.equal(inferFamilyClassification(2, 'רווק/ה').value, 'משפחה עם הורה עצמאי  (חד הוריות)');
  });
  test('married couple with 3+ household is זוג הורים', () => {
    assert.equal(inferFamilyClassification(4, 'נשוי/אה').value, 'משפחה עם זוג הורים');
  });
  test('missing household size needs input', () => {
    assert.equal(inferFamilyClassification(0, 'נשוי/אה').needsInput, true);
  });
  test('ambiguous combination needs input', () => {
    // size 2, not married and not single-parent-marked and not רווק -> unresolved.
    // (Note: isMarried/isSingleParent match by substring, e.g. "ידוע" as in
    // "ידוע/ה בציבור" - avoid marital strings containing those substrings here.)
    const result = inferFamilyClassification(2, 'סטטוס לא מוכר');
    assert.equal(result.needsInput, true);
  });
});

describe('inferBirthCountry', () => {
  test('exact hint match', () => {
    assert.equal(inferBirthCountry('מרוקו').value, 'ארצות ערב');
  });
  test('already a valid site option passes through', () => {
    assert.equal(inferBirthCountry('ישראל').value, 'ישראל');
  });
  test('unknown country needs input', () => {
    assert.equal(inferBirthCountry('נרניה').needsInput, true);
  });
  test('empty value needs input', () => {
    assert.equal(inferBirthCountry('').needsInput, true);
  });
});

describe('routePhone', () => {
  test('9-digit mobile without leading zero pads to 10 and routes to mobile', () => {
    const result = routePhone('501234567');
    assert.equal(result.field, 'mobilePhone');
    assert.equal(result.value, '0501234567');
  });
  test('full 10-digit 05 mobile routes to mobile unchanged', () => {
    const result = routePhone('0521234567');
    assert.equal(result.field, 'mobilePhone');
    assert.equal(result.value, '0521234567');
  });
  test('8-digit landline without leading zero pads to 9 and routes to home', () => {
    const result = routePhone('21234567');
    assert.equal(result.field, 'homePhone');
    assert.equal(result.value, '021234567');
  });
  test('9-digit landline with leading zero routes to home, kept at 9 digits', () => {
    const result = routePhone('021234567');
    assert.equal(result.field, 'homePhone');
    assert.equal(result.value, '021234567');
  });
  test('a landline with an invalid area code falls back to the placeholder', () => {
    // 071234567 -> starts with "07", not a valid landline prefix.
    const result = routePhone('71234567');
    assert.equal(result.field, 'homePhone');
    assert.equal(result.value, '020000000');
  });
  test('empty / missing phone falls back to the placeholder', () => {
    assert.deepEqual(routePhone(''), { field: 'homePhone', value: '020000000' });
    assert.deepEqual(routePhone(null), { field: 'homePhone', value: '020000000' });
  });
  test('valid landline prefixes are kept as-is', () => {
    for (const p of ['031234567', '041234567', '081234567', '091234567']) {
      assert.equal(routePhone(p).value, p);
    }
  });
  test('an 05 mobile with more than 10 digits is invalid -> constant home number', () => {
    assert.deepEqual(routePhone('05012345678'), { field: 'homePhone', value: '020000000' });
    assert.deepEqual(routePhone('0501234567890'), { field: 'homePhone', value: '020000000' });
  });
  test('any number longer than 10 digits falls back to the placeholder', () => {
    assert.deepEqual(routePhone('031234567890'), { field: 'homePhone', value: '020000000' });
  });
});

describe('normalizeHolocaust', () => {
  test('כן/לא pass through', () => {
    assert.equal(normalizeHolocaust('כן'), 'כן');
    assert.equal(normalizeHolocaust('לא'), 'לא');
  });
  test('english yes/no normalize to Hebrew', () => {
    assert.equal(normalizeHolocaust('yes'), 'כן');
    assert.equal(normalizeHolocaust('no'), 'לא');
  });
  test('empty defaults to לא', () => {
    assert.equal(normalizeHolocaust(''), 'לא');
  });
});
