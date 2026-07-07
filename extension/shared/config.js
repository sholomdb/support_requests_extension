/** FormTitan / IFCJ site configuration */
import { normalizeCity } from './utils.js';

export const SITE = {
  homeUrl: 'https://ifcjil.formtitan.com/ftproject/ifcjaid/IFCJAIDHOME',
  mutavUrl: 'ifcjil.formtitan.com/ftproject/ifcjaid/MUTAV',
  catalogUrl: 'https://ifcjil.formtitan.com/ftproject/ifcjaid/CATALOG',
  whoHowMUrl: 'https://ifcjil.formtitan.com/ftproject/ifcjaid/WhoHowM',
  hostPattern: 'ifcjil.formtitan.com',
};

/** Fixed site values */
export const CONSTANTS = {
  mutavKnowledge: ['yes', 'כן'],
  ministryFileExists: ['כן'],
  supplier: 'אש"ל חב"ד ירושלים',
  // של"מ budgets (BUDGET_LABELS[5]) require an extra "תכנית" dropdown on WhoHowM set to this.
  shalamProgram: 'תכנית יתד',
};

/** Budget label index whose WhoHowM form has the extra שלמ "תכנית" dropdown. */
export const SHALAM_LABEL_INDEX = 5;

/** CATALOG budget labels (label:nth-child index → text) */
export const BUDGET_LABELS = {
  1: 'סיוע חירום למשפחות',
  2: 'אזרחים ותיקים',
  3: 'ניצולי שואה',
  4: 'בתי משפט קהילתיים',
  5: 'של"מ',
  6: 'נפגעי אלימות במשפחה',
};

/** Login ID per city (same password for all – entered manually) */
export const DEFAULT_CITIES = {
  'אלעד': { loginId: '', slug: 'elad', siteSearch: 'אלעד' },
  'ביתר עילית': { loginId: '', slug: 'beytar', siteSearch: 'ביתר עילית' },
  'בית אל': { loginId: '', slug: 'bet-el', siteSearch: 'בית אל' },
  'מודיעין': { loginId: '', slug: 'modiin', siteSearch: 'מודיעין עילית' },
  'מודיעין עילית': { loginId: '', slug: 'modiin', siteSearch: 'מודיעין עילית' },
  'בני ברק': { loginId: '063203442', slug: 'bnei-brak', siteSearch: 'בני ברק' },
  'חברון': { loginId: '', slug: 'hevron', siteSearch: 'ועד יהודי חברון' },
  'מטה בנימין': { loginId: '', slug: 'mateh-binyamin', siteSearch: 'מטה בנימין' },
};

export const DEFAULT_SELECTORS = {
  navigation: {
    newRecordButton: '#e25',
  },
  step1: {
    idNumber: '#e199',
    idLookupButton: '#e2847',
    lastName: '#e200',
    firstName: '#e201',
    mutavKnowledge: '#controle362',
    gender: '#e209',
    sector: '#e210',
    ministryFileExists: '#e211',
    maritalStatus: '#e212',
    householdSize: '#e213',
    holocaustSurvivor: '#e2848',
    birthCountry: '#e216',
    birthDate: '#e217',
    familyClassification: '#e218',
    street: '#e223',
    building: '#e224',
    city: '#e229',
    settlement: '#e233',
    mobilePhone: '#e231',
    homePhone: '#e232',
    nextButton: '#e238',
  },
  step2: {
    budgetGroup: '#e687',
    budgetLabelPrefix: '#e687 label:nth-child',
    // Item search box - filtering to a single result and clicking a fixed
    // "index 0" element is far more reliable than any specific item's own
    // per-render instance id (see docs/PIPELINE.md "item selectors").
    itemSearch: '#e421',
    itemRepeaterRoot: 's287',
    nextButton: '',
  },
  step3: {
    item: '',
    itemCategory: '',
    nextButton: '',
  },
  step4: {
    reason: '#e434',
    budgetSource: '#e424',
    supplier: '#e304',
    amount: '#e305',
    submitButton: '#e361',
    // Extra "תכנית" dropdown, only present/filled for של"מ budgets.
    shalamProgram: '#e1843',
  },
  balance: {
    currentBalance: '',
  },
  // Home-page "budget sources" PowerTable (#e978): source name in the 90d5826b column,
  // remaining-to-use ("יתרה לניצול") in the 5ca47b4d column. Cells are matched within each
  // body row by their column-id suffix, so this survives row re-ordering/virtualization.
  budgetSources: {
    table: '#e978',
    row: '[data-id^="power-table-row-e978-"]',
    name: '[data-id$="-90d5826b-e69e-4aa9-bf50-654e03264bd0"]',
    remaining: '[data-id$="-5ca47b4d-9bf5-4a29-980f-bcd2d4e90cce"]',
  },
};

export const DEFAULT_SETTINGS = {
  cities: DEFAULT_CITIES,
  selectors: DEFAULT_SELECTORS,
  siteUrl: SITE.homeUrl,
  fillDelayMs: 400,
  idLookupWaitMs: 4000,
  searchWaitMs: 1500,
  // Max time to wait for any stage to navigate to its next page (step 1->2, 2->3, and the
  // final 3->home submit). Polling returns as soon as the page changes, so a fast transition
  // never waits this long; the budget is generous to avoid marking a slow-but-successful
  // transition (especially the final submit) as failed.
  pageWaitMs: 20000,
  autoAdvance: false,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    cities: mergeCities(DEFAULT_CITIES, settings?.cities),
    selectors: mergeSelectors(DEFAULT_SELECTORS, settings?.selectors),
  };
}

function mergeCities(defaults, overrides) {
  const result = { ...defaults };
  if (!overrides) return result;
  for (const [name, cfg] of Object.entries(overrides)) {
    result[name] = { ...defaults[name], ...cfg, loginId: cfg.loginId ?? defaults[name]?.loginId ?? '' };
  }
  return result;
}

function mergeSelectors(defaults, overrides) {
  if (!overrides) return defaults;
  const result = {};
  for (const step of Object.keys(defaults)) {
    result[step] = { ...defaults[step] };
    if (overrides[step]) {
      for (const [key, val] of Object.entries(overrides[step])) {
        if (val) result[step][key] = val;
      }
    }
  }
  for (const step of Object.keys(overrides)) {
    if (!result[step]) result[step] = overrides[step];
  }
  return result;
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

export function findCityLoginId(cities, cityName) {
  if (!cityName) return '';
  const normalized = normalizeCity(cityName);
  if (cities[normalized]?.loginId) return cities[normalized].loginId;
  for (const [name, cfg] of Object.entries(cities)) {
    if (normalizeCity(name) === normalized) return cfg.loginId || '';
    if (cfg.slug && cfg.slug === cityName.toLowerCase().trim()) return cfg.loginId || '';
  }
  return '';
}

export function getCitySiteSearch(cities, cityName) {
  if (!cityName) return '';
  const normalized = normalizeCity(cityName);
  if (cities[normalized]?.siteSearch) return cities[normalized].siteSearch;
  for (const [name, cfg] of Object.entries(cities)) {
    if (normalizeCity(name) === normalized) return cfg.siteSearch || name;
  }
  return normalized;
}

export function isMatehBinyamin(cityName) {
  const c = normalizeCity(cityName);
  return c === 'מטה בנימין';
}
