/**
 * Upload-time pipeline: raw Excel row -> validated, site-ready row -> fillable requests.
 *
 * This is the single place to edit when a field's fix (normalize/map) or validate
 * behavior needs to change. See docs/PIPELINE.md for the full field table and the
 * reasoning behind the `rowKey`/`requestId` split.
 */
import { normalizeText, normalizeIdNumber, normalizeBirthDate, isValidBirthDate } from './utils.js';
import { getCitySiteSearch, isMatehBinyamin, CONSTANTS, SHALAM_LABEL_INDEX } from './config.js';
import { resolveMapping, mappingKey, MAP_TYPES, getSuggestions, getItemMaxPrice, getAllMappings } from './mappings.js';
import { isCatalogBudget, budgetHasItem, catalogMaxPrice } from './catalog-data.js';
import {
  inferFamilyClassification,
  inferBirthCountry,
  routePhone,
  normalizeHolocaust,
} from './inference.js';

export const ROW_STATUS = {
  READY: 'ready',
  NEEDS_MAPPING: 'needs-mapping',
  INVALID: 'invalid',
  // Money that no budget source in the row's list could fund (see allocateSources).
  OUT_OF_BUDGET: 'out-of-budget',
};
export const STEP_STATUS = { PENDING: 'pending', FILLED: 'filled', FAILED: 'failed' };

function required(reason) {
  return (value) => (value ? null : reason);
}

function defaultOutputAs(field) {
  // mapType fields without a custom outputAs just want the plain site value,
  // not the {siteValue, labelIndex, selector} entry passed in as outputSource.
  return (outputSource) => ({ [field.key]: field.mapType ? outputSource.siteValue : outputSource });
}

/**
 * Identifies which uploaded file a row came from, so re-uploading a genuinely
 * different file never merges into a previous file's progress. Deliberately just
 * the file name (not size/hash): the supported "fix a row" workflow is editing a
 * cell and re-uploading the *same* file, which almost always changes the saved
 * file's byte size (xlsx re-compression) even for a one-character edit - keying
 * on size would treat every fix as a new file and defeat the merge entirely.
 */
export function fileIdOf(fileName) {
  return normalizeText(fileName).toLowerCase();
}

export function rowKeyOf(fileId, rawRow) {
  return `${fileId}::${rawRow.idNumber || 'noid'}::${rawRow.excelRow}`;
}

/**
 * One entry per output field. `fix` runs for plain fields; `mapType` fields are
 * resolved ahead of time via collectMappingQueue()'s resolved-value cache instead
 * (never awaited here - buildRow() is pure and synchronous).
 */
const FIELD_PIPELINE = [
  { key: 'idNumber', step: 1, fix: (raw) => normalizeIdNumber(raw.idNumber), validate: (v) => (/^\d{9}$/.test(v) ? null : 'ת.ז. לא תקינה (נדרשות 9 ספרות)') },
  { key: 'lastName', step: 1, fix: (raw) => normalizeText(raw.lastName), validate: required('שם משפחה חסר') },
  { key: 'firstName', step: 1, fix: (raw) => normalizeText(raw.firstName), validate: required('שם פרטי חסר') },
  { key: 'gender', step: 1, fix: (raw) => normalizeText(raw.gender), validate: required('מגדר חסר') },
  { key: 'sector', step: 1, fix: (raw) => normalizeText(raw.sector), validate: required('מגזר חסר') },
  { key: 'ministryFileExists', step: 1, fix: () => 'כן' },
  { key: 'mutavKnowledge', step: 1, fix: () => 'כן' },
  { key: 'maritalStatus', step: 1, fix: (raw) => normalizeText(raw.maritalStatus), validate: required('מצב משפחתי חסר') },
  { key: 'householdSize', step: 1, fix: (raw) => String(raw.householdSize || ''), validate: (v) => (Number(v) > 0 ? null : 'מספר נפשות לא תקין') },
  { key: 'holocaustSurvivor', step: 1, fix: (raw) => normalizeHolocaust(raw.holocaustSurvivor) },
  { key: 'birthDate', step: 1, fix: (raw) => normalizeBirthDate(raw.birthDate), validate: (v) => (isValidBirthDate(v) ? null : 'תאריך לידה לא תקין') },
  { key: 'street', step: 1, fix: (raw) => normalizeText(raw.street) },
  { key: 'building', step: 1, fix: (raw) => normalizeText(raw.building) },
  {
    key: 'citySearch',
    step: 1,
    mapType: MAP_TYPES.city,
    source: (raw) => raw.city,
    context: (raw) => ({ city: raw.city }),
    fallback: (raw, settings) => getCitySiteSearch(settings?.cities || {}, raw.city),
    validate: required('עיר לא נפתרה'),
  },
  {
    key: 'settlement',
    step: 1,
    fix: (raw) => (isMatehBinyamin(raw.city) ? normalizeText(raw.settlement) : ''),
    outputAs: (value, raw) => ({ settlement: value, needsSettlement: isMatehBinyamin(raw.city) }),
    validate: (value, raw) => (isMatehBinyamin(raw.city) && !value ? 'ישוב חסר (מטה בנימין)' : null),
  },
  {
    key: 'birthCountry',
    step: 1,
    mapType: MAP_TYPES.birthCountry,
    source: (raw) => raw.birthCountry,
    inferFallback: (raw) => inferBirthCountry(raw.birthCountry),
    validate: required('ארץ לידה לא נפתרה'),
  },
  {
    key: 'familyClassification',
    step: 1,
    mapType: MAP_TYPES.familyClassification,
    source: (raw) => `${raw.householdSize}::${normalizeText(raw.maritalStatus)}`,
    context: (raw) => ({ householdSize: raw.householdSize, maritalStatus: raw.maritalStatus }),
    inferFallback: (raw) => inferFamilyClassification(raw.householdSize, raw.maritalStatus),
    // "זוג ללא ילדים" is only valid for a married couple of exactly 2 - flag any row
    // that resolved to it otherwise (a wrong mapping or bad source data).
    validate: (value, raw) => {
      if (!value) return 'סיווג משפחה לא נפתר';
      if (value.includes('זוג ללא ילדים')) {
        const size = Number(raw.householdSize) || 0;
        const married = /נשוי|ידוע/.test(normalizeText(raw.maritalStatus));
        if (size !== 2 || !married) {
          return 'סיווג "זוג ללא ילדים" מחייב מצב משפחתי נשוי/אה וגודל משפחה 2';
        }
      }
      return null;
    },
  },
  {
    key: 'phone',
    step: 1,
    fix: (raw) => routePhone(raw.phone),
    outputAs: (route) => ({ [route.field]: route.value }),
    validate: (route) => (route?.value ? null : 'טלפון לא תקין'),
  },
  {
    key: 'budgetType',
    step: 2,
    mapType: MAP_TYPES.budgetType,
    source: (raw) => raw.budgetType,
    outputAs: (entry) => ({ budgetLabelIndex: entry?.labelIndex, budgetSiteValue: entry?.siteValue }),
    validate: required('סוג תקציב לא נפתר'),
  },
  {
    key: 'item',
    step: 2,
    mapType: MAP_TYPES.item,
    source: (raw) => raw.item,
    outputAs: (entry) => ({ itemSelector: entry?.selector, itemSiteValue: entry?.siteValue, itemMaxPrice: entry?.maxPrice ?? null }),
    validate: required('פריט לא נפתר'),
  },
  {
    key: 'budgetSource',
    step: 3,
    mapType: MAP_TYPES.budgetSource,
    // Config-only: never prompted during upload. Resolved from the Settings-configured list
    // for (resolved budget label, city). Keyed on fields.budgetSiteValue, which the earlier
    // budgetType field has already set by the time this field runs.
    configOnly: true,
    source: (raw, fields) => fields?.budgetSiteValue || '',
    context: (raw, fields) => ({ budgetLabel: fields?.budgetSiteValue, city: raw.city }),
    // Resolves to an ordered priority list; the single per-request budgetSourceSearch is
    // assigned later by the allocator/request-builder, not here.
    outputAs: (entry) => ({ budgetSourceList: entry?.siteValues ?? (entry?.siteValue ? [entry.siteValue] : []) }),
    validate: (v, raw, fields) =>
      v ? null : `מקור תקציב לא הוגדר בהגדרות עבור "${fields?.budgetSiteValue || raw.budgetType}" ב${raw.city}`,
  },
  { key: 'amount', step: 3, fix: (raw) => String(raw.amount), validate: (v) => (Number(v) > 0 ? null : 'סכום לא תקין') },
  { key: 'reason', step: 3, fix: (raw) => normalizeText(raw.justification) },
  { key: 'supplier', step: 3, fix: () => CONSTANTS.supplier },
];

function mapFields() {
  // configOnly fields (budgetSource) are resolved from Settings config, never prompted.
  return FIELD_PIPELINE.filter((f) => f.mapType && !f.configOnly);
}

/**
 * Scans every row for unresolved categorical mappings and returns:
 *  - resolved: Map<"type::key", {siteValue, labelIndex, selector}> for everything
 *    already resolvable (saved mapping, seed, or inference fallback)
 *  - queue: one entry per unique unresolved (type, key) pair, with every affected
 *    row's key collected, ready to drive a batched operator-prompt UI.
 */
export async function collectMappingQueue(rawRows, fileId, settings) {
  const resolved = new Map();
  const queueMap = new Map();

  for (const raw of rawRows) {
    const rowKey = rowKeyOf(fileId, raw);
    for (const field of mapFields()) {
      const excelValue = field.source(raw);
      const context = field.context ? field.context(raw) : {};
      const key = mappingKey(field.mapType, excelValue, context);
      const cacheKey = `${field.mapType}::${key}`;

      if (resolved.has(cacheKey)) continue;
      if (queueMap.has(cacheKey)) {
        queueMap.get(cacheKey).affectedRowKeys.push(rowKey);
        continue;
      }

      const result = await resolveMapping(field.mapType, excelValue, context);
      if (!result.needsInput) {
        let siteValue = result.siteValue;
        if (field.fallback && !siteValue) siteValue = field.fallback(raw, settings);
        const maxPrice = field.mapType === MAP_TYPES.item ? await getItemMaxPrice(siteValue) : undefined;
        resolved.set(cacheKey, { siteValue, siteValues: result.siteValues, labelIndex: result.labelIndex, selector: result.selector, maxPrice });
        continue;
      }

      if (field.inferFallback) {
        const inferred = field.inferFallback(raw);
        if (!inferred.needsInput) {
          resolved.set(cacheKey, { siteValue: inferred.value });
          continue;
        }
      }

      queueMap.set(cacheKey, {
        type: field.mapType,
        fieldKey: field.key,
        excelValue: normalizeText(excelValue),
        context,
        key,
        suggestions: result.suggestions || (await getSuggestions(field.mapType)),
        affectedRowKeys: [rowKey],
      });
    }
  }

  // budgetSource is config-only: load every configured (label::city) list into the resolved
  // cache so buildRow can look it up synchronously. Unconfigured combos simply won't be found
  // and buildRow fails that row with a "configure in Settings" error.
  const bsConfig = (await getAllMappings())[MAP_TYPES.budgetSource] || {};
  for (const [key, entry] of Object.entries(bsConfig)) {
    resolved.set(`${MAP_TYPES.budgetSource}::${key}`, {
      siteValue: entry.siteValue,
      siteValues: entry.siteValues ?? (entry.siteValue ? [entry.siteValue] : []),
    });
  }

  return { resolved, queue: [...queueMap.values()] };
}

/**
 * Pure, synchronous: applies fix + validate to one raw row using an already-resolved
 * mapping cache (from collectMappingQueue). Never awaits anything.
 */
export function buildRow(rawRow, resolvedMap, fileId) {
  const rowKey = rowKeyOf(fileId, rawRow);
  const fields = {};
  const errors = [];
  let hasNeedsMapping = false;

  for (const field of FIELD_PIPELINE) {
    let value;
    let outputSource;

    if (field.mapType) {
      const excelValue = field.source(rawRow, fields);
      const context = field.context ? field.context(rawRow, fields) : {};
      const key = mappingKey(field.mapType, excelValue, context);
      const entry = resolvedMap.get(`${field.mapType}::${key}`);
      if (entry) {
        value = entry.siteValue;
        outputSource = entry;
      } else {
        // configOnly fields (budgetSource) aren't prompted - a miss is a hard config error
        // (INVALID via validate), not a NEEDS_MAPPING the operator resolves in a prompt.
        if (!field.configOnly) hasNeedsMapping = true;
        value = '';
        outputSource = { siteValue: '', labelIndex: undefined, selector: undefined };
      }
    } else {
      value = field.fix(rawRow);
      outputSource = value;
    }

    const outputAs = field.outputAs || defaultOutputAs(field);
    Object.assign(fields, outputAs(outputSource, rawRow));

    if (field.validate) {
      const reason = field.validate(value, rawRow, fields);
      if (reason) errors.push({ field: field.key, reason });
    }
  }

  // Cross-field: the resolved item must exist in the resolved budget's catalog, and
  // its per-budget "מחיר מירבי" becomes itemMaxPrice (used to split over-limit
  // requests). Only checked once both are resolved (else it's still NEEDS_MAPPING).
  const budget = fields.budgetSiteValue;
  const item = fields.itemSiteValue;
  if (budget && item) {
    if (isCatalogBudget(budget) && !budgetHasItem(budget, item)) {
      errors.push({ field: 'item', reason: `הפריט "${item}" לא קיים בתקציב "${budget}"` });
    }
    const catPrice = catalogMaxPrice(budget, item);
    if (catPrice != null) fields.itemMaxPrice = catPrice;
  }

  // של"מ budgets need the fixed "בחירת אוכלוסיה" dropdown on WhoHowM; others leave it empty.
  fields.shalamProgram =
    Number(fields.budgetLabelIndex) === SHALAM_LABEL_INDEX ? CONSTANTS.shalamProgram : '';

  let status = ROW_STATUS.READY;
  if (hasNeedsMapping) status = ROW_STATUS.NEEDS_MAPPING;
  else if (errors.length) status = ROW_STATUS.INVALID;

  return { ...rawRow, fields, errors, status, rowKey };
}

/**
 * Splits a total amount into chunks no larger than maxPrice. e.g. total 900,
 * limit 500 -> [500, 400]. No limit (null/0) or within limit -> [total].
 */
export function splitAmount(total, maxPrice) {
  const amount = Number(total) || 0;
  const limit = Number(maxPrice) || 0;
  if (limit <= 0 || amount <= limit) return [amount];
  const chunks = [];
  let remaining = amount;
  while (remaining > limit) {
    chunks.push(limit);
    remaining -= limit;
  }
  if (remaining > 0) chunks.push(remaining);
  return chunks;
}

/** Marker source name for the out-of-budget remainder in a requestId. */
export const OOB_SOURCE = 'OOB';

/** All money is whole NIS: the "never drain a source below 1 NIS" rule is integer arithmetic. */
function nis(x) {
  return Math.round(Number(x) || 0);
}

/**
 * Cross-row, order-dependent allocation of each row's amount across its ordered budget
 * source list (row.fields.budgetSourceList), drawing down a shared remaining pool. Assumes
 * every row will succeed, so it plans the whole file up front. MUST receive builtRows in
 * Excel order - a source pool is consumed top-to-bottom and later rows see earlier draws.
 *
 * Rule: a source can never be drained below 1 NIS, so the most drawable from a source is
 * (remaining - 1). Leftover the list can't fund becomes out-of-budget. Only a local clone
 * of the snapshot is mutated; the caller owns persistence.
 *
 * @param {Array} builtRows  rows from buildRow(), in Excel order
 * @param {Object} snapshot  { [sourceName]: number } remaining per source
 * @returns {Map<string, {segments: Array<{source,amount}>, outOfBudget: number, unresolved?: boolean}>}
 *          keyed by rowKey
 */
export function allocateSources(builtRows, snapshot = {}) {
  // Key the pool by normalized source name so a snapshot read from the home-page table
  // (whitespace/spacing as rendered) matches the source names chosen in the mapping list.
  const pool = {};
  for (const k of Object.keys(snapshot)) pool[normalizeText(k)] = nis(snapshot[k]);

  const out = new Map();
  for (const row of builtRows) {
    // Unresolved/invalid rows don't consume budget and aren't "out of budget" - they keep
    // their own status until the operator fixes them (then allocation re-runs).
    if (row.status !== ROW_STATUS.READY) {
      out.set(row.rowKey, { segments: [], outOfBudget: 0, unresolved: true });
      continue;
    }
    let wanted = nis(row.fields.amount);
    if (wanted <= 0) {
      out.set(row.rowKey, { segments: [], outOfBudget: 0 });
      continue;
    }
    const segments = [];
    for (const source of row.fields.budgetSourceList || []) {
      if (wanted <= 0) break;
      const poolKey = normalizeText(source);
      const avail = pool[poolKey];
      if (avail === undefined) continue; // source not on the home-page table => treated as 0
      const take = Math.min(wanted, Math.max(0, avail - 1)); // leave >= 1 NIS
      if (take <= 0) continue;
      pool[poolKey] = avail - take;
      wanted -= take;
      segments.push({ source, amount: take });
    }
    out.set(row.rowKey, { segments, outOfBudget: wanted }); // leftover = out of budget
  }
  return out;
}

/**
 * One row -> one or more fillable requests. Two-level split: the allocation (allocateSources)
 * gives ordered funded segments {source, amount} plus an out-of-budget remainder; each segment
 * is then split by the item's per-budget price cap (row.fields.itemMaxPrice) so no request
 * exceeds it. Every request draws from exactly one source (fields.budgetSourceSearch). An
 * out-of-budget remainder is flagged (status OUT_OF_BUDGET, skipped by the batch fill) but
 * still carries the first source in the row's list as its budgetSourceSearch, so an operator
 * who deliberately runs "מלא בקשה" on it can complete the fill (knowingly overspending it).
 *
 * requestId is `${rowKey}::${source|'OOB'}:${segIdx}:${splitIdx}` - identity is pinned to
 * (row, source, price-split position), NOT list position, because the split is now
 * data-dependent on the remaining-balances snapshot. mergeRequestsOnReupload then preserves
 * a chunk's progress only when that exact chunk of work reproduces, and correctly drops it
 * when a segment changes (instead of copying stale steps onto a differently-sized request).
 */
export function buildRequests(row, allocation) {
  const alloc = allocation?.get(row.rowKey) || {
    segments: [],
    outOfBudget: row.status === ROW_STATUS.READY ? nis(row.fields.amount) : 0,
    unresolved: row.status !== ROW_STATUS.READY,
  };

  const chunks = [];
  alloc.segments.forEach((seg, segIdx) => {
    splitAmount(seg.amount, row.fields.itemMaxPrice).forEach((amount, k) => {
      chunks.push({ amount, source: seg.source, oob: false, segIdx, k });
    });
  });
  if (alloc.outOfBudget > 0) {
    splitAmount(alloc.outOfBudget, row.fields.itemMaxPrice).forEach((amount, k) => {
      chunks.push({ amount, source: null, oob: true, segIdx: -1, k });
    });
  }
  // Unresolved/invalid rows (or amount <= 0) produce no segments: keep one placeholder request
  // carrying the original status so the operator still sees the row and can fix it.
  if (!chunks.length) {
    chunks.push({ amount: nis(row.fields.amount), source: null, oob: false, segIdx: -1, k: 0 });
  }

  // An out-of-budget chunk has no allocated source; fall back to the first source in the
  // row's priority list so a deliberate manual fill still has a source to submit.
  const fallbackSource = row.fields.budgetSourceList?.[0] || '';

  return chunks.map((c, i) => {
    const source = c.oob ? fallbackSource : c.source || '';
    return {
      requestId: `${row.rowKey}::${c.oob ? OOB_SOURCE : c.source ?? 'NA'}:${c.segIdx}:${c.k}`,
      rowKey: row.rowKey,
      splitIndex: i,
      splitCount: chunks.length,
      fields: { ...row.fields, amount: String(c.amount), budgetSourceSearch: source },
      sourceLabel: source || null,
      outOfBudget: c.oob,
      status: c.oob ? ROW_STATUS.OUT_OF_BUDGET : row.status,
      errors: row.errors,
      steps: { 1: STEP_STATUS.PENDING, 2: STEP_STATUS.PENDING, 3: STEP_STATUS.PENDING },
    };
  });
}

/**
 * Builds the full request list for a set of built rows, given the allocation. Ordering:
 * each row's primary funded request in row order first, then funded overflow chunks, then
 * ALL out-of-budget requests last - so actionable rows stay on top. Safe to reorder because
 * requestId identity is independent of list position.
 */
export function buildAllRequests(rows, allocation) {
  const perRow = rows.map((r) => buildRequests(r, allocation));
  const primary = [];
  const overflow = [];
  const oob = [];
  for (const reqs of perRow) {
    const funded = reqs.filter((r) => !r.outOfBudget);
    oob.push(...reqs.filter((r) => r.outOfBudget));
    if (funded.length) {
      primary.push(funded[0]);
      overflow.push(...funded.slice(1));
    }
  }
  return [...primary, ...overflow, ...oob];
}

/** Matches rebuilt rows against the previous upload by rowKey (which is file-scoped). */
export function mergeRowsOnReupload(existingRows, newBuiltRows) {
  const newKeys = new Set(newBuiltRows.map((r) => r.rowKey));
  const droppedCount = (existingRows || []).filter((r) => !newKeys.has(r.rowKey)).length;
  return { rows: newBuiltRows, droppedCount };
}

/** Preserves per-step fill progress for requests that still exist after a re-upload. */
export function mergeRequestsOnReupload(existingRequests, newRequests) {
  const existingById = new Map((existingRequests || []).map((r) => [r.requestId, r]));
  return newRequests.map((req) => {
    const prev = existingById.get(req.requestId);
    return prev ? { ...req, steps: prev.steps } : req;
  });
}

export { FIELD_PIPELINE };
