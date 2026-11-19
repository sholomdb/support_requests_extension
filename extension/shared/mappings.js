import { normalizeText, normalizeCity } from './utils.js';
import { BUDGET_LABELS } from './config.js';
import { catalogItemNames } from './catalog-data.js';
import { MARITAL_OPTIONS, SECTOR_OPTIONS } from './inference.js';

export const MAP_TYPES = {
  budgetType: 'budgetType',
  birthCountry: 'birthCountry',
  city: 'city',
  budgetSource: 'budgetSource',
  item: 'item',
  familyClassification: 'familyClassification',
  maritalStatus: 'maritalStatus',
  sector: 'sector',
};

/** Hebrew label per map type, for anything operator-facing (Settings + the mapping
 * prompt in the side panel). Kept here so the two UIs can't drift apart. */
export const MAP_TYPE_LABELS = {
  [MAP_TYPES.city]: 'עיר',
  [MAP_TYPES.budgetType]: 'סוג תקציב',
  [MAP_TYPES.item]: 'פריט',
  [MAP_TYPES.budgetSource]: 'מקור תקציב',
  [MAP_TYPES.birthCountry]: 'ארץ לידה',
  [MAP_TYPES.familyClassification]: 'סיווג משפחה',
  [MAP_TYPES.maritalStatus]: 'מצב משפחתי',
  [MAP_TYPES.sector]: 'מגזר',
};

export function mappingKey(type, excelValue, context = {}) {
  const val = normalizeText(excelValue);
  if (type === MAP_TYPES.budgetSource) {
    const city = normalizeCity(context.city || '');
    // Keyed by the resolved *site budget label* (one of BUDGET_LABELS) + city, so a
    // Settings-configured combo matches a file row deterministically. context.budgetType is
    // accepted as a legacy fallback for entries created before the label re-key/migration.
    const budget = normalizeText(context.budgetLabel || context.budgetType || '');
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
  const existing = all[type][key];
  // budgetSource resolves to an ordered *priority list* of sources (pass extra.siteValues);
  // every other type stays single-valued. siteValue mirrors the first entry for back-compat.
  let siteValues = extra.siteValues?.length ? extra.siteValues : undefined;
  // Never silently drop an existing budgetSource list when a caller saves a single value
  // (e.g. an edit via the generic mapping table) - keep the extra sources.
  if (!siteValues && type === MAP_TYPES.budgetSource && existing?.siteValues?.length) {
    siteValues = existing.siteValues;
  }
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

  // A value that already IS a site option resolves to itself - nothing to translate. There
  // are no built-in Excel->site maps: any other wording is asked once and saved.
  const exact = exactSiteOption(type, excelValue);
  if (exact) return { ...exact, fromSiteOption: true };

  return {
    needsInput: true,
    type,
    excelValue: normalizeText(excelValue),
    context,
    key,
    suggestions: await getSuggestions(type),
  };
}

/**
 * The site option `excelValue` equals verbatim (after whitespace normalization), or null.
 * budgetType also carries its CATALOG label index. budgetSource / familyClassification have
 * no single-value site option to match (config list / computed tuple).
 */
export function exactSiteOption(type, excelValue) {
  const v = normalizeText(excelValue);
  if (!v || type === MAP_TYPES.budgetSource || type === MAP_TYPES.familyClassification) return null;
  if (type === MAP_TYPES.budgetType) {
    const hit = Object.entries(BUDGET_LABELS).find(([, label]) => normalizeText(label) === v);
    return hit ? { siteValue: hit[1], labelIndex: Number(hit[0]) } : null;
  }
  const options = HARDCODED_SUGGESTIONS[type] || [];
  const hit = options.find((o) => normalizeText(o) === v);
  return hit ? { siteValue: hit } : null;
}

/** Built-in starting picklist per type - merged with operator-managed categories below.
 * budgetSource starts empty on purpose: it has no fixed site enum, it becomes
 * categorical purely through use (see addCategory/saveMapping) and manual additions
 * in Settings → קטגוריות. item starts with every catalog-data.js item name and grows the same
 * way as new items are captured/used. */
export const HARDCODED_SUGGESTIONS = {
  [MAP_TYPES.budgetType]: Object.values(BUDGET_LABELS),
  [MAP_TYPES.birthCountry]: ['ישראל', 'אחר', 'אסיה', 'ארצות המערב', 'מזרח אירופה', 'ארצות ערב', 'אתיופיה', 'דרום אמריקה', 'חמ"ע FSU', 'אפריקה'],
  [MAP_TYPES.city]: ['אלעד', 'ביתר עילית', 'בני ברק', 'ועד יהודי חברון', 'בית אל', 'מודיעין עילית', 'מטה בנימין'],
  [MAP_TYPES.familyClassification]: ['משפחה עם זוג הורים', 'משפחה עם הורה עצמאי  (חד הוריות)', 'זוג ללא ילדים', 'בודד'],
  [MAP_TYPES.maritalStatus]: MARITAL_OPTIONS,
  [MAP_TYPES.sector]: SECTOR_OPTIONS,
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

export function buildBudgetSourceKey(budgetLabel, city) {
  return mappingKey(MAP_TYPES.budgetSource, budgetLabel, { budgetLabel, city });
}

/**
 * Reads the ordered budget-source list configured for a (site budget label, city) combo.
 * Returns [] when nothing is configured - the caller (buildRow) then fails the row and
 * points the operator to Settings. This is the sole resolution path now that budgetSource
 * is configured up-front instead of prompted during upload.
 */
export async function getBudgetSourceList(budgetLabel, city) {
  const all = await getAllMappings();
  const key = buildBudgetSourceKey(budgetLabel, city);
  const entry = all[MAP_TYPES.budgetSource]?.[key];
  if (!entry) return [];
  return entry.siteValues?.length ? entry.siteValues : entry.siteValue ? [entry.siteValue] : [];
}

/**
 * One-time migration: budgetSource lists used to be keyed by the raw Excel budget text
 * (context.budgetType); they're now keyed by the resolved site budget label. Re-key any
 * legacy entries by resolving their budgetType, so existing lists survive the switch.
 * Idempotent - entries already carrying a budgetLabel context are left untouched.
 */
export async function migrateBudgetSourceToLabelKeys() {
  const all = await getAllMappings();
  const bs = all[MAP_TYPES.budgetSource];
  if (!bs) return { migrated: 0 };
  let migrated = 0;
  for (const [oldKey, entry] of Object.entries(bs)) {
    if (entry.context?.budgetLabel) continue; // already label-keyed
    const rawBudget = entry.context?.budgetType;
    const city = entry.context?.city;
    if (!rawBudget || !city) continue;
    const resolvedBudget = await resolveMapping(MAP_TYPES.budgetType, rawBudget, {});
    const label = resolvedBudget?.siteValue;
    if (!label) continue; // can't determine the label - leave as-is (row will fail -> reconfigure)
    const newKey = buildBudgetSourceKey(label, city);
    const migratedEntry = { ...entry, context: { budgetLabel: label, city }, excelValue: `${label}::${city}` };
    delete bs[oldKey];
    bs[newKey] = { ...bs[newKey], ...migratedEntry }; // merge if a label-keyed entry already exists
    migrated += 1;
  }
  if (migrated) await chrome.storage.local.set({ valueMappings: all });
  return { migrated };
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
