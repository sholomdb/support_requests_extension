import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  normalizeIdNumber,
  normalizeCity,
  normalizeBirthDate,
  isValidBirthDate,
  excelDateToString,
  formatPhone,
  formatCurrency,
} from '../extension/shared/utils.js';

describe('normalizeText', () => {
  test('trims and collapses whitespace', () => {
    assert.equal(normalizeText('  a   b  '), 'a b');
  });
  test('handles null/undefined', () => {
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
  });
});

describe('normalizeIdNumber', () => {
  test('pads short ids to 9 digits', () => {
    assert.equal(normalizeIdNumber('12345'), '000012345');
  });
  test('leaves 9-digit ids unchanged', () => {
    assert.equal(normalizeIdNumber('123456789'), '123456789');
  });
  test('strips non-digits before padding', () => {
    assert.equal(normalizeIdNumber('123-45-678'), '012345678');
  });
  test('empty input stays empty', () => {
    assert.equal(normalizeIdNumber(''), '');
    assert.equal(normalizeIdNumber(null), '');
  });
});

describe('normalizeCity', () => {
  test('maps known aliases to canonical name', () => {
    assert.equal(normalizeCity('ביתר'), 'ביתר עילית');
    assert.equal(normalizeCity('beytar'), 'ביתר עילית');
    assert.equal(normalizeCity('מודיעין'), 'מודיעין עילית');
  });
  test('passes through unknown city names unchanged', () => {
    assert.equal(normalizeCity('עיר לא ידועה'), 'עיר לא ידועה');
  });
  test('strips a municipality prefix, then maps to the canonical name', () => {
    assert.equal(normalizeCity('עיריית בני ברק'), 'בני ברק');
    assert.equal(normalizeCity('עירית ביתר'), 'ביתר עילית');
    assert.equal(normalizeCity('מועצה מקומית מודיעין'), 'מודיעין עילית');
  });
  test('strips a municipality prefix even for cities without an alias', () => {
    assert.equal(normalizeCity('עיריית פלונית'), 'פלונית');
  });
});

describe('normalizeBirthDate', () => {
  test('normalizes dotted short-year date', () => {
    assert.equal(normalizeBirthDate('5.3.85'), '05/03/1985');
  });
  test('normalizes slash full-year date', () => {
    assert.equal(normalizeBirthDate('05/03/1985'), '05/03/1985');
  });
  test('converts an Excel serial date', () => {
    // 1985-03-05 as an Excel serial (1900 date system)
    assert.equal(normalizeBirthDate('31111'), '05/03/1985');
  });
  test('empty input stays empty', () => {
    assert.equal(normalizeBirthDate(''), '');
  });
  test('swaps American mm/dd/yyyy to Israeli dd/mm/yyyy when month is impossible', () => {
    assert.equal(normalizeBirthDate('02/16/1996'), '16/02/1996');
    assert.equal(normalizeBirthDate('12/31/1990'), '31/12/1990');
  });
  test('leaves an already-valid dd/mm date untouched (does not swap when both <= 12)', () => {
    assert.equal(normalizeBirthDate('02/03/1996'), '02/03/1996');
  });
});

describe('isValidBirthDate', () => {
  test('accepts a real dd/mm/yyyy date', () => {
    assert.equal(isValidBirthDate('16/02/1996'), true);
    assert.equal(isValidBirthDate('29/02/2000'), true); // leap year
  });
  test('rejects month > 12', () => {
    assert.equal(isValidBirthDate('02/16/1996'), false);
  });
  test('rejects impossible day (31/02, 29/02 non-leap)', () => {
    assert.equal(isValidBirthDate('31/02/1996'), false);
    assert.equal(isValidBirthDate('29/02/1999'), false);
  });
  test('rejects wrong format or out-of-range year', () => {
    assert.equal(isValidBirthDate('1996-02-16'), false);
    assert.equal(isValidBirthDate('16/02/1850'), false);
    assert.equal(isValidBirthDate(''), false);
  });
});

describe('excelDateToString', () => {
  test('converts a known serial to DD/MM/YYYY', () => {
    assert.equal(excelDateToString(31111), '05/03/1985');
  });
});

describe('formatPhone', () => {
  test('adds leading zero to a 9-digit number', () => {
    assert.equal(formatPhone('501234567'), '0501234567');
  });
  test('leaves a valid 10-digit number unchanged', () => {
    assert.equal(formatPhone('0501234567'), '0501234567');
  });
});

describe('formatCurrency', () => {
  test('formats with locale thousands separators', () => {
    assert.equal(formatCurrency(1234), '1,234');
  });
  test('non-numeric input formats as 0', () => {
    assert.equal(formatCurrency('abc'), '0');
  });
});
