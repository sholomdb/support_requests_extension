import { normalizeText, normalizeCity } from './utils.js';
import { BUDGET_LABELS } from './config.js';
import { catalogItemNames } from './catalog-data.js';

export const MAP_TYPES = {
  budgetType: 'budgetType',
  birthCountry: 'birthCountry',
  city: 'city',
  budgetSource: 'budgetSource',
  item: 'item',
  familyClassification: 'familyClassification',
};

/** Default Excel → site mappings (operator can override) */
export const DEFAULT_SEEDS = {
  budgetType: {
    'משפחות': { siteValue: BUDGET_LABELS[1], labelIndex: 1 },
    'אזרח ותיק': { siteValue: BUDGET_LABELS[2], labelIndex: 2 },
    'ניצולי שואה': { siteValue: BUDGET_LABELS[3], labelIndex: 3 },
    'אלימות': { siteValue: BUDGET_LABELS[6], labelIndex: 6 },
    'אלימות ': { siteValue: BUDGET_LABELS[6], labelIndex: 6 },
    'נפגעי אלימות': { siteValue: BUDGET_LABELS[6], labelIndex: 6 },
    'מלחמה': { siteValue: BUDGET_LABELS[5], labelIndex: 5 },
    'צעירים': { siteValue: BUDGET_LABELS[5], labelIndex: 5 },
    'צעירים (תיקון)': { siteValue: BUDGET_LABELS[5], labelIndex: 5 },
  },
  city: {
    'אלעד': { siteValue: 'אלעד' },
    'ביתר עילית': { siteValue: 'ביתר עילית' },
    'ביתר': { siteValue: 'ביתר עילית' },
    'בני ברק': { siteValue: 'בני ברק' },
    'חברון': { siteValue: 'ועד יהודי חברון' },
    'בית אל': { siteValue: 'בית אל' },
    'מודיעין': { siteValue: 'מודיעין עילית' },
    'מודיעין עילית': { siteValue: 'מודיעין עילית' },
    'מטה בנימין': { siteValue: 'מטה בנימין' },
  },
  birthCountry: {},
  budgetSource: {},
  // Seeded from the catalog files (catalog-data.js): an Excel item value that exactly
  // matches a known catalog item name resolves to itself automatically, no operator
  // prompt. A saved operator mapping still overrides this if the Excel wording differs.
  item: Object.fromEntries(catalogItemNames().map((name) => [name, { siteValue: name }])),
  familyClassification: {},
};

export function mappingKey(type, excelValue, context = {}) {
  const val = normalizeText(excelValue);
  if (type === MAP_TYPES.budgetSource) {
    const city = normalizeCity(context.city || '');
    const budget = normalizeText(context.budgetType || '');
    return `${budget}::${city}`;
  }
  if (type === MAP_TYPES.familyClassification) {
    const size = context.householdSize ?? '';
    const marital = normalizeText(context.maritalStatus || '');
    return `${size}::${marital}`;
  }
  return val;
}

export async function getAllMappings() {
  const { valueMappings } = await chrome.storage.local.get('valueMappings');
  return valueMappings || {};
}

export async function saveMapping(type, excelValue, siteValue, context = {}, extra = {}) {
  const key = mappingKey(type, excelValue, context);
  const all = await getAllMappings();
  if (!all[type]) all[type] = {};
  // budgetSource resolves to an ordered *priority list* of sources (pass extra.siteValues);
  // every other type stays single-valued. siteValue mirrors the first entry for back-compat.
  const siteValues = extra.siteValues?.length ? extra.siteValues : undefined;
  const primary = siteValues ? siteValues[0] : siteValue;
  all[type][key] = {
    excelValue: normalizeText(excelValue),
    siteValue: primary,
    ...(siteValues ? { siteValues } : {}),
    context,
    labelIndex: extra.labelIndex,
    selector: extra.selector ?? (type === MAP_TYPES.item ? primary : undefined),
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ valueMappings: all });
  // Every chosen site value becomes a future suggestion for this type - this is what
  // makes item/budgetSource (which have no hardcoded picklist) behave categorically
  // over time, same as city/budgetType/etc.
  for (const v of siteValues || [siteValue]) await addCategory(type, v);
  return all[type][key];
}

export async function deleteMapping(type, excelValue, context = {}) {
  const key = mappingKey(type, excelValue, context);
  const all = await getAllMappings();
  if (all[type]?.[key]) {
    delete all[type][key];
    await chrome.storage.local.set({ valueMappings: all });
  }
}

export async function resolveMapping(type, excelValue, context = {}) {
  const key = mappingKey(type, excelValue, context);
  const stored = await getAllMappings();
  const userMap = stored[type]?.[key];
  if (userMap?.siteValue !== undefined) {
    return {
      siteValue: userMap.siteValue,
      // Ordered source list for budgetSource; legacy single-value entries read as a 1-item list.
      siteValues: userMap.siteValues ?? [userMap.siteValue],
      labelIndex: userMap.labelIndex,
      selector: userMap.selector,
      fromUser: true,
    };
  }

  const seeds = DEFAULT_SEEDS[type] || {};
  const seedKey = type === MAP_TYPES.budgetSource ? key : normalizeText(excelValue);
  const seed = seeds[seedKey] || seeds[normalizeCity(excelValue)] || seeds[normalizeText(excelValue)];
  if (seed) {
    return { siteValue: seed.siteValue, labelIndex: seed.labelIndex, selector: seed.selector, fromSeed: true };
  }

  if (type === MAP_TYPES.city) {
    const normalized = normalizeCity(excelValue);
    const citySeed = seeds[normalized];
    if (citySeed) return { siteValue: citySeed.siteValue, fromSeed: true };
  }

  return {
    needsInput: true,
    type,
    excelValue: normalizeText(excelValue),
    context,
    key,
    suggestions: await getSuggestions(type),
  };
}

/** Built-in starting picklist per type - merged with operator-managed categories below.
 * budgetSource starts empty on purpose: it has no fixed site enum, it becomes
 * categorical purely through use (see addCategory/saveMapping) and manual additions
 * in Settings → קטגוריות. item starts seeded from item-catalog.js and grows the same
 * way as new items are captured/used. */
export const HARDCODED_SUGGESTIONS = {
  [MAP_TYPES.budgetType]: Object.values(BUDGET_LABELS),
  [MAP_TYPES.birthCountry]: ['ישראל', 'אחר', 'אסיה', 'ארצות המערב', 'מזרח אירופה', 'ארצות ערב', 'אתיופיה', 'דרום אמריקה', 'חמ"ע FSU', 'אפריקה'],
  [MAP_TYPES.city]: ['אלעד', 'ביתר עילית', 'בני ברק', 'ועד יהודי חברון', 'בית אל', 'מודיעין עילית', 'מטה בנימין'],
  [MAP_TYPES.familyClassification]: ['משפחה עם זוג הורים', 'משפחה עם הורה עצמאי  (חד הוריות)', 'זוג ללא ילדים', 'בודד'],
  [MAP_TYPES.item]: catalogItemNames(),
  [MAP_TYPES.budgetSource]: [],
};

function dedupeByNormalizedText(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = normalizeText(v).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function getAllCategories() {
  const { categories } = await chrome.storage.local.get('categories');
  return categories || {};
}

/** The operator-facing picklist for a type: hardcoded starting values + anything
 * ever chosen or manually added, so item/budgetSource grow into real categories
 * as they're used instead of staying free-text forever. */
export async function getSuggestions(type) {
  const stored = await getAllCategories();
  return dedupeByNormalizedText([...(HARDCODED_SUGGESTIONS[type] || []), ...(stored[type] || [])]);
}

export async function addCategory(type, value) {
  const v = normalizeText(value);
  if (!v) return;
  const all = await getAllCategories();
  const list = all[type] || [];
  if (list.some((x) => normalizeText(x).toLowerCase() === v.toLowerCase())) return;
  all[type] = [...list, v];
  await chrome.storage.local.set({ categories: all });
}

export async function removeCategory(type, value) {
  const v = normalizeText(value).toLowerCase();
  const all = await getAllCategories();
  all[type] = (all[type] || []).filter((x) => normalizeText(x).toLowerCase() !== v);
  await chrome.storage.local.set({ categories: all });
}

/** Operator-captured item info (DOM selector / an override maxPrice) stored per item
 * name in chrome.storage.local. The authoritative per-budget prices live in
 * catalog-data.js; this only holds operator additions/overrides. */
export async function getAllItemInfo() {
  const { itemCatalog } = await chrome.storage.local.get('itemCatalog');
  return itemCatalog || {};
}

export async function setItemInfo(itemName, info = {}) {
  const name = normalizeText(itemName);
  if (!name) return;
  const all = await getAllItemInfo();
  all[name] = { ...all[name], ...info };
  await chrome.storage.local.set({ itemCatalog: all });
}

/** Operator-captured maxPrice override for an item (falls back to catalog-data.js's
 * per-budget price in the pipeline). Returns null if the operator hasn't set one. */
export async function getItemMaxPrice(itemName) {
  const name = normalizeText(itemName);
  if (!name) return null;
  const stored = await getAllItemInfo();
  return stored[name]?.maxPrice ?? null;
}

export function buildBudgetSourceKey(budgetType, city) {
  return mappingKey(MAP_TYPES.budgetSource, budgetType, { budgetType, city });
}

/** All operator-taught data kept in chrome.storage.local (mappings, categories,
 * captured item selectors/prices) - bundled for settings export/import. */
export async function exportMappingData() {
  const { valueMappings, categories, itemCatalog } = await chrome.storage.local.get([
    'valueMappings',
    'categories',
    'itemCatalog',
  ]);
  return {
    valueMappings: valueMappings || {},
    categories: categories || {},
    itemCatalog: itemCatalog || {},
  };
}

export async function importMappingData(data = {}) {
  const set = {};
  if (data.valueMappings) set.valueMappings = data.valueMappings;
  if (data.categories) set.categories = data.categories;
  if (data.itemCatalog) set.itemCatalog = data.itemCatalog;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
}

export async function listMappingsFlat() {
  const all = await getAllMappings();
  const rows = [];
  for (const [type, entries] of Object.entries(all)) {
    for (const [key, entry] of Object.entries(entries)) {
      rows.push({ type, key, ...entry });
    }
  }
  return rows;
}
