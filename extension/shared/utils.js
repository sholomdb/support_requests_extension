/** Excel serial date (1900 system) → DD/MM/YYYY */
export function excelDateToString(serial) {
  const n = Number(serial);
  if (!n || Number.isNaN(n)) return String(serial || '');

  const utcDays = Math.floor(n - 25569);
  const date = new Date(utcDays * 86400000);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Normalize birth date to DD/MM/YYYY (handles . or / separators, short day/month/year) */
export function normalizeBirthDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';

  const asNum = Number(s);
  if (
    !Number.isNaN(asNum) &&
    asNum > 1000 &&
    asNum < 200000 &&
    !/[./-]/.test(s)
  ) {
    return excelDateToString(asNum);
  }

  const parts = s.split(/[./-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return s;

  let dayNum = parseInt(parts[0], 10);
  let monthNum = parseInt(parts[1], 10);
  let yearNum = parseInt(parts[2], 10);
  if (Number.isNaN(dayNum) || Number.isNaN(monthNum) || Number.isNaN(yearNum)) return s;

  // The site uses Israeli dd/mm/yyyy. If the "month" is impossible (>12) but the
  // "day" could be a month, the source was American mm/dd/yyyy (e.g. 02/16/1996) -
  // swap so it becomes 16/02/1996.
  if (monthNum > 12 && dayNum <= 12) {
    [dayNum, monthNum] = [monthNum, dayNum];
  }

  if (parts[2].length <= 2) {
    yearNum = yearNum > 30 ? 1900 + yearNum : 2000 + yearNum;
  }

  const dd = String(dayNum).padStart(2, '0');
  const mm = String(monthNum).padStart(2, '0');
  const yyyy = String(yearNum).padStart(4, '0');
  return `${dd}/${mm}/${yyyy}`;
}

/** True only if `value` is a real DD/MM/YYYY calendar date (rejects month>12,
 * impossible days like 31/02, out-of-range years). */
export function isValidBirthDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return false;
  const day = +m[1];
  const month = +m[2];
  const year = +m[3];
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2100) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/** Israeli ID – pad with leading zeros to 9 digits */
export function normalizeIdNumber(id) {
  const digits = String(id ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length < 9 ? digits.padStart(9, '0') : digits;
}

export function normalizeCity(city) {
  const c = normalizeText(city);
  const aliases = {
    // ביתר עילית – common Excel spellings
    'ביתר': 'ביתר עילית',
    'ביתר עילית': 'ביתר עילית',
    'ביתר עילית ': 'ביתר עילית',
    'ביתר עלית': 'ביתר עילית',
    'ביתר עיית': 'ביתר עילית',
    'beytar': 'ביתר עילית',
    // אלעד
    'אלעד': 'אלעד',
    'elad': 'אלעד',
    // בית אל
    'בית אל': 'בית אל',
    'bet-el': 'בית אל',
    // מודיעין
    'מודיעין': 'מודיעין עילית',
    'מודיעין עילית': 'מודיעין עילית',
    'modiin': 'מודיעין עילית',
    // בני ברק
    'בני ברק': 'בני ברק',
    'bnei-brak': 'בני ברק',
    'bnei brak': 'בני ברק',
    // חברון
    'חברון': 'חברון',
    'hevron': 'חברון',
    'hebron': 'חברון',
    'מטה בנימין': 'מטה בנימין',
  };
  const key = c.toLowerCase();
  return aliases[c] || aliases[key] || c;
}

export function formatPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `0${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  return digits;
}

export function formatCurrency(amount) {
  const n = Number(amount);
  if (Number.isNaN(n)) return '0';
  return n.toLocaleString('he-IL');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Trigger input/change events so React/Angular forms detect updates */
export function setNativeValue(element, value) {
  const proto =
    element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function selectOptionByText(selectEl, text) {
  const target = normalizeText(text);
  const options = [...selectEl.options];
  let match = options.find((o) => normalizeText(o.text) === target);
  if (!match) {
    match = options.find((o) => normalizeText(o.text).includes(target) || target.includes(normalizeText(o.text)));
  }
  if (match) {
    selectEl.value = match.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

export async function clickByText(container, tag, text) {
  const target = normalizeText(text);
  const elements = container.querySelectorAll(tag);
  for (const el of elements) {
    if (normalizeText(el.textContent) === target || normalizeText(el.textContent).includes(target)) {
      el.click();
      return true;
    }
  }
  return false;
}
