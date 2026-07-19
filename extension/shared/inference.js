import { normalizeText } from './utils.js';

const SINGLE_PARENT_STATUSES = ['גרוש/ה', 'אלמנ/ה', 'אלמנה', 'פרוד/ה'];
const MARRIED_STATUSES = ['נשוי/אה', 'נשוי/א', 'ידוע/ה בציבור'];

export const FAMILY_OPTIONS = [
  'משפחה עם זוג הורים',
  'משפחה עם הורה עצמאי (חד הוריות)',
  'משפחה עם הורה עצמאי  (חד הוריות)',
  'זוג ללא ילדים',
  'בודד',
];

function normalizeMarital(status) {
  return normalizeText(status);
}

/** The site's marital-status dropdown options (canonical values). */
export const MARITAL_OPTIONS = ['נשוי/אה', 'רווק/ה', 'גרוש/ה', 'אלמן/ה', 'פרוד/ה', 'ידוע/ה בציבור'];

/**
 * Canonicalizes an Excel marital status to the site's dropdown value - Excel files carry
 * grammar variants (נשוי, נשואה, גרושה, אלמן…) that don't text-match the site's נשוי/אה
 * style options. Root-based, so any gendered/spacing variant of a known status resolves
 * without an operator prompt. Returns { value } or { needsInput: true }.
 */
export function inferMaritalStatus(value) {
  const m = normalizeMarital(value);
  if (!m) return { needsInput: true, reason: 'missing marital status' };
  if (MARITAL_OPTIONS.includes(m)) return { value: m };
  // "ידוע/ה בציבור" - but NOT "לא ידוע" (unknown), which must go to the operator.
  if (m.includes('ידוע') && !/לא\s*ידוע/.test(m)) return { value: 'ידוע/ה בציבור' };
  if (m.includes('נשוי') || m.includes('נשוא')) return { value: 'נשוי/אה' };
  if (m.includes('רווק')) return { value: 'רווק/ה' };
  if (m.includes('גרוש')) return { value: 'גרוש/ה' };
  if (m.includes('אלמ')) return { value: 'אלמן/ה' };
  if (m.includes('פרוד')) return { value: 'פרוד/ה' };
  return { needsInput: true, reason: `unrecognized marital status "${m}"` };
}

function isSingleParent(maritalStatus) {
  const m = normalizeMarital(maritalStatus);
  return m.includes('גרוש') || m.includes('אלמנ') || m.includes('פרוד');
}

function isMarried(maritalStatus) {
  const m = normalizeMarital(maritalStatus);
  return m.includes('נשוי') || m.includes('ידוע');
}

/**
 * Infer family classification from household size + marital status.
 * Returns { value } or { needsInput: true, reason }
 */
export function inferFamilyClassification(householdSize, maritalStatus) {
  const size = Number(householdSize) || 0;
  const marital = normalizeMarital(maritalStatus);

  if (size <= 0) {
    return { needsInput: true, reason: 'missing household size' };
  }

  if (size === 1) {
    return { value: 'בודד' };
  }

  if (size === 2 && isMarried(marital)) {
    return { value: 'זוג ללא ילדים' };
  }

  if (size >= 2 && isSingleParent(marital)) {
    return { value: 'משפחה עם הורה עצמאי  (חד הוריות)' };
  }

  if (size >= 3 && isMarried(marital)) {
    return { value: 'משפחה עם זוג הורים' };
  }

  // A single (רווק/ה) person listed with other people in the household is treated as
  // a single-parent family (same as גרוש/ה) - almost always a data-entry case where
  // the marital status wasn't updated (a truly lone single is caught by size === 1).
  if (size >= 2 && marital.includes('רווק')) {
    return { value: 'משפחה עם הורה עצמאי  (חד הוריות)' };
  }

  return { needsInput: true, reason: `cannot infer: size=${size}, marital=${marital}` };
}

/** Birth country Excel → site category hints */
const BIRTH_COUNTRY_HINTS = {
  'ישראל': 'ישראל',
  'מרוקו': 'ארצות ערב',
  'תימן': 'ארצות ערב',
  'עיראק': 'ארצות ערב',
  'איראן': 'ארצות ערב',
  'רומניה': 'מזרח אירופה',
  'פולין': 'מזרח אירופה',
  'רוסיה': 'מזרח אירופה',
  'אוקראינה': 'מזרח אירופה',
  'אתיופיה': 'אתיופיה',
  'ארגנטינה': 'דרום אמריקה',
  'ברזיל': 'דרום אמריקה',
  'ארה"ב': 'ארצות המערב',
  'צרפת': 'ארצות המערב',
  'גרמניה': 'ארצות המערב',
  'בריטניה': 'ארצות המערב',
  'אנגליה': 'ארצות המערב',
  'מצרים': 'ארצות ערב',
  'טורקיה': 'אחר',
  'הודו': 'אסיה',
  'סין': 'אסיה',
};

export const BIRTH_COUNTRY_OPTIONS = [
  'ישראל', 'אחר', 'אסיה', 'ארצות המערב', 'מזרח אירופה',
  'ארצות ערב', 'אתיופיה', 'דרום אמריקה', 'חמ"ע FSU', 'אפריקה',
];

export function inferBirthCountry(excelCountry) {
  const c = normalizeText(excelCountry);
  if (!c) return { needsInput: true, reason: 'missing birth country' };

  if (BIRTH_COUNTRY_HINTS[c]) {
    return { value: BIRTH_COUNTRY_HINTS[c] };
  }

  for (const [key, val] of Object.entries(BIRTH_COUNTRY_HINTS)) {
    if (c.includes(key) || key.includes(c)) return { value: val };
  }

  if (BIRTH_COUNTRY_OPTIONS.includes(c)) {
    return { value: c };
  }

  return { needsInput: true, excelValue: c };
}

/** Valid Israeli landline area codes and a placeholder for unusable landlines. */
const LANDLINE_PREFIXES = ['02', '03', '04', '08', '09'];
const PLACEHOLDER_HOME_PHONE = '020000000';

/**
 * Route a phone number to mobile (#e231) or home (#e232).
 *
 * Excel often drops the leading zero (numbers stored numerically), so decide by
 * padding to the standard length first:
 *  - pad to 10 digits; if it then starts with "05" AND has at most 10 digits it's a
 *    mobile -> #e231, kept at 10 digits (e.g. 501234567 -> 0501234567). More than 10
 *    digits is an invalid mobile and falls back to the constant home number.
 *  - otherwise it's a landline -> #e232, padded to 9 digits (NOT 10)
 *    (e.g. 21234567 -> 021234567). If the padded number doesn't start with a valid
 *    area code (02/03/04/08/09) - including a missing/garbage number - it's replaced
 *    with the placeholder 020000000 so the request can still proceed.
 */
export function routePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const asMobile = digits.padStart(10, '0');
  // A valid Israeli mobile is exactly 10 digits (05XXXXXXXX). More than 10 digits is an
  // invalid mobile - fall back to the constant home number rather than filling it.
  if (asMobile.startsWith('05') && digits.length <= 10) {
    return { field: 'mobilePhone', value: asMobile };
  }
  let home = digits.padStart(9, '0');
  if (digits.length > 10 || !LANDLINE_PREFIXES.includes(home.slice(0, 2))) {
    home = PLACEHOLDER_HOME_PHONE;
  }
  return { field: 'homePhone', value: home };
}

export function normalizeHolocaust(value) {
  const v = normalizeText(value);
  if (v === 'כן' || v.toLowerCase() === 'yes') return 'כן';
  if (v === 'לא' || v.toLowerCase() === 'no') return 'לא';
  return v || 'לא';
}
