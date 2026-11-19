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
export const MARITAL_OPTIONS = ['נשוי/אה', 'רווק/ה', 'גרוש/ה', 'אלמנ/ה', 'פרוד/ה', 'ידוע/ה בציבור'];

/** The site's sector dropdown options (#e210), in the order the site lists them.
 * These strings must match the dropdown verbatim to be selectable. */
export const SECTOR_OPTIONS = ['דרוזי', 'יהודי', 'מוסלמי', 'נוצרי', 'בדואי', 'אחר/טרם נמסר'];

function isSingleParent(maritalStatus) {
  const m = normalizeMarital(maritalStatus);
  return m.includes('גרוש') || m.includes('אלמנ') || m.includes('פרוד');
}

function isMarried(maritalStatus) {
  const m = normalizeMarital(maritalStatus);
  return m.includes('נשוי') || m.includes('ידוע');
}

/** First whole number in a household-size cell ("4", "4 נפשות", 4) - 0 when none/empty. */
export function parseHouseholdSize(value) {
  const m = String(value ?? '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/**
 * Household size actually used for the row: the Excel value when it's a positive number,
 * otherwise inferred from the (resolved) marital status - married/ידוע בציבור -> 2,
 * any other known status -> 1, and no marital status either -> the default 2 (a married
 * couple, see EMPTY_DEFAULTS). Returns { value: string, defaulted: boolean }.
 */
export function effectiveHouseholdSize(rawSize, resolvedMarital, defaultSize = '2') {
  const size = parseHouseholdSize(rawSize);
  if (size > 0) return { value: String(size), defaulted: false };
  const m = normalizeMarital(resolvedMarital);
  if (!m) return { value: String(defaultSize), defaulted: true };
  return { value: isMarried(m) ? '2' : '1', defaulted: true };
}

/**
 * Marital status to use when the Excel cell is empty, inferred from household size:
 * a household of 1 -> רווק/ה, anything else (including an empty size) -> the default
 * (נשוי/אה). Returns '' when the cell isn't empty (the normal mapping path handles it).
 */
export function inferMaritalFromSize(rawMarital, rawSize, defaultMarital = 'נשוי/אה') {
  if (normalizeMarital(rawMarital)) return '';
  return parseHouseholdSize(rawSize) === 1 ? 'רווק/ה' : defaultMarital;
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

export const BIRTH_COUNTRY_OPTIONS = [
  'ישראל', 'אחר', 'אסיה', 'ארצות המערב', 'מזרח אירופה',
  'ארצות ערב', 'אתיופיה', 'דרום אמריקה', 'חמ"ע FSU', 'אפריקה',
];

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
  let digits = String(phone ?? '').replace(/\D/g, '');
  // International form: +972 / 00972 / 972 followed by the number without its leading 0
  // (e.g. +972-50-123-4567 -> 0501234567, 972-2-1234567 -> 021234567).
  digits = digits.replace(/^00/, '');
  if (digits.startsWith('972') && (digits.length === 11 || digits.length === 12)) {
    digits = `0${digits.slice(3)}`;
  }
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

/**
 * Holocaust-survivor answer for the row: an explicit כן/לא (or yes/no) in Excel wins;
 * an empty or unrecognized cell is decided by the budget - כן for the ניצולי שואה budget,
 * לא for anything else. Returns { value, defaulted }.
 */
export function resolveHolocaust(value, budgetLabel) {
  const v = normalizeText(value).toLowerCase();
  if (v === 'כן' || v === 'yes') return { value: 'כן', defaulted: false };
  if (v === 'לא' || v === 'no') return { value: 'לא', defaulted: false };
  const isSurvivorBudget = normalizeText(budgetLabel).includes('ניצולי שואה');
  return { value: isSurvivorBudget ? 'כן' : 'לא', defaulted: true };
}

export function normalizeHolocaust(value) {
  const v = normalizeText(value);
  if (v === 'כן' || v.toLowerCase() === 'yes') return 'כן';
  if (v === 'לא' || v.toLowerCase() === 'no') return 'לא';
  return v || 'לא';
}
