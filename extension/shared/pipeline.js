/**
 * Upload-time pipeline: raw Excel row -> validated, site-ready row -> fillable requests.
 *
 * This is the single place to edit when a field's fix (normalize/map) or validate
 * behavior needs to change. See docs/PIPELINE.md for the full field table and the
 * reasoning behind the `rowKey`/`requestId` split.
 */
import { normalizeText, normalizeIdNumber, normalizeBirthDate, isValidBirthDate } from './utils.js';
import { getCitySiteSearch, isMatehBinyamin, CONSTANTS } from './config.js';
import { resolveMapping, mappingKey, MAP_TYPES, getSuggestions, getItemMaxPrice } from './mappings.js';
import { isCatalogBudget, budgetHasItem, catalogMaxPrice } from './catalog-data.js';
import {
  inferFamilyClassification,
  inferBirthCountry,
  routePhone,
  normalizeHolocaust,
} from './inference.js';

export const ROW_STATUS = { READY: 'ready', NEEDS_MAPPING: 'needs-mapping', INVALID: 'invalid' };
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
    source: (raw) => `${raw.budgetType}::${raw.city}`,
    context: (raw) => ({ budgetType: raw.budgetType, city: raw.city }),
    outputAs: (entry) => ({ budgetSourceSearch: entry?.siteValue }),
    validate: required('מקור תקציב לא נפתר'),
  },
  { key: 'amount', step: 3, fix: (raw) => String(raw.amount), validate: (v) => (Number(v) > 0 ? null : 'סכום לא תקין') },
  { key: 'reason', step: 3, fix: (raw) => normalizeText(raw.justification) },
  { key: 'supplier', step: 3, fix: () => CONSTANTS.supplier },
];

function mapFields() {
  return FIELD_PIPELINE.filter((f) => f.mapType);
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
        resolved.set(cacheKey, { siteValue, labelIndex: result.labelIndex, selector: result.selector, maxPrice });
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
      const excelValue = field.source(rawRow);
      const context = field.context ? field.context(rawRow) : {};
      const key = mappingKey(field.mapType, excelValue, context);
      const entry = resolvedMap.get(`${field.mapType}::${key}`);
      if (entry) {
        value = entry.siteValue;
        outputSource = entry;
      } else {
        hasNeedsMapping = true;
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
      const reason = field.validate(value, rawRow);
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

/**
 * One row -> one or more fillable requests, split so no request's amount exceeds the
 * item's per-budget limit (row.fields.itemMaxPrice, from catalog-data.js). e.g. an
 * item with a 500 limit requested at 900 yields two requests: 500 and 400, each with
 * all the other fields identical.
 *
 * requestId is `${rowKey}::${chunkIndex}`. Since rowKey is `fileId::idNumber::excelRow`
 * and the split is deterministic from (amount, limit), re-uploading the same file
 * reproduces identical requestIds - so mergeRequestsOnReupload still matches each
 * chunk and preserves its progress. (Editing the amount in Excel may change how many
 * chunks a row produces; chunks that no longer exist are dropped on re-upload, chunk
 * ::0 keeps its progress.)
 */
export function buildRequests(row) {
  const chunks = splitAmount(row.fields.amount, row.fields.itemMaxPrice);
  return chunks.map((amount, i) => ({
    requestId: `${row.rowKey}::${i}`,
    rowKey: row.rowKey,
    splitIndex: i,
    splitCount: chunks.length,
    fields: { ...row.fields, amount: String(amount) },
    status: row.status,
    errors: row.errors,
    steps: { 1: STEP_STATUS.PENDING, 2: STEP_STATUS.PENDING, 3: STEP_STATUS.PENDING },
  }));
}

/**
 * Builds the full request list for a set of built rows: every row's primary request
 * (chunk ::0) in original row order first, then all overflow chunks (::1, ::2, ...)
 * appended at the end - so a split adds "the same row again" at the end of the table,
 * rather than interleaving.
 */
export function buildAllRequests(rows) {
  const perRow = rows.map(buildRequests);
  const primary = perRow.map((reqs) => reqs[0]).filter(Boolean);
  const overflow = perRow.flatMap((reqs) => reqs.slice(1));
  return [...primary, ...overflow];
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
