import { parseExcelBuffer } from '../shared/excel-parser.js';
import { loadSettings, findCityLoginId, SITE } from '../shared/config.js';
import {
  getSession,
  saveSession,
  setStepStatus,
  isRequestDone,
  getBudgetSourceRemaining,
  saveBudgetSourceRemaining,
} from '../shared/storage.js';
import { formatCurrency, normalizeText, normalizeCity } from '../shared/utils.js';
import {
  collectMappingQueue,
  buildRow,
  buildAllRequests,
  allocateSources,
  mergeRowsOnReupload,
  mergeRequestsOnReupload,
  fileIdOf,
  ROW_STATUS,
  STEP_STATUS,
} from '../shared/pipeline.js';
import { saveMapping, MAP_TYPES, migrateBudgetSourceToLabelKeys } from '../shared/mappings.js';
import { buildIdLookupRequest, parseMappingResponse, isAuthFailure } from '../shared/api.js';
import { buildSmsRequest, buildVerifyRequest, parseVerifyResponse } from '../shared/ft-login.js';
import { getCityCredentials } from '../shared/storage.js';

let settings = null;
let session = null;
let currentStep = 1;
let automationRunning = false;
let stopRequested = false;
let rowFilter = 'all';

/** A request can be filled if its data is complete. Out-of-budget rows ARE fillable on
 * demand ("מלא בקשה") - only unresolved/invalid rows (missing data) are blocked. */
function isFillable(request) {
  return request.status !== ROW_STATUS.NEEDS_MAPPING && request.status !== ROW_STATUS.INVALID;
}

/** של"מ requests carry a non-empty shalamProgram (see pipeline buildRow); they're exempt
 * from the site's under-18 age warning, which we auto-confirm ("תקון") for them. */
function isShalamRequest(request) {
  return Boolean(request?.fields?.shalamProgram);
}

/** Row-list filter (also gates which requests the "מלא בקשות מהנוכחית" batch runs on). */
function matchesFilter(request) {
  switch (rowFilter) {
    case 'undone':
      return !isRequestDone(request);
    case 'failed':
      return [1, 2, 3].some((s) => request.steps[s] === STEP_STATUS.FAILED);
    case 'needsfix':
      return request.status !== ROW_STATUS.READY;
    case 'outofbudget':
      return request.status === ROW_STATUS.OUT_OF_BUDGET;
    default:
      return true;
  }
}
let pendingMapping = null;
let mappingQueue = [];
let mappingResolveCallback = null;
// Ordered budget-source list being built in the mapping prompt (budgetSource type only).
let sourceListDraft = [];
let lastWorkingFrameId = null;

const STEP_PAGES = { 1: 'MUTAV', 2: 'CATALOG', 3: 'WhoHowM' };

/** The page a stage must reach for it to count as passed:
 *  MUTAV  --(#e238 next)-->  CATALOG
 *  CATALOG --(item click)-->  WhoHowM   (no next/submit button on the site)
 *  WhoHowM --(#e361 submit)-> home
 * A stage is only marked "filled" once its fields succeeded AND the page actually
 * changed to this expected page - so a failure at the last stage no longer shows a
 * false 3/3 / green line. */
const EXPECTED_NEXT_PAGE = { 1: 'catalog', 2: 'whohowm', 3: 'home' };
const NEXT_PAGE_LABEL = { catalog: 'CATALOG', whohowm: 'WhoHowM', home: 'דף הבית' };
// Informational results that don't, on their own, mean the stage's fields failed.
const SOFT_FIELDS = new Set(['idLookupWait']);

/** A stage's fields are OK only if every (non-informational) field result was
 * filled or intentionally skipped (readonly). result.ok alone just means the fill
 * ran, which is why it was marking failed stages as passed. */
function allFieldsOk(result) {
  if (!result?.ok) return false;
  const rs = (result.results || []).filter((r) => !SOFT_FIELDS.has(r.field));
  if (!rs.length) return false;
  return rs.every((r) => r.ok || r.skipped);
}

/** Polls the page type until it becomes `expected` (the site navigated) or times out. */
async function waitForPageChange(expected, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getPageInfoForTab();
    const page = info?.page && info.page !== 'unknown' ? info.page : pageFromTabUrl(info?.url);
    if (page === expected) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Like waitForPageChange, but also bails the moment an error popup appears - the
 * stage failed regardless of navigation. Returns { navigated } | { error } | { timeout }. */
async function waitForStageOutcome(expected, timeoutMs = 8000, opts = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getPageInfoForTab();
    if (info?.errorPopup) {
      // של"מ budgets: the under-18 age warning is expected - confirm it ("תקון") and keep
      // waiting for the page to navigate, instead of failing the stage.
      if (opts.shalam) {
        const res = await sendToContent({ type: 'CONFIRM_AGE_WARNING' });
        if (res?.confirmed) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      }
      return { error: info.errorPopup };
    }
    const page = info?.page && info.page !== 'unknown' ? info.page : pageFromTabUrl(info?.url);
    if (page === expected) return { navigated: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { timeout: true };
}

/** One-shot check for an error popup currently on the page. */
async function currentErrorPopup() {
  const info = await getPageInfoForTab();
  return info?.errorPopup || null;
}

const $ = (id) => document.getElementById(id);

async function init() {
  settings = await loadSettings();
  await migrateBudgetSourceToLabelKeys();
  session = await getSession();

  // Read straight from the manifest so it never drifts out of sync with the real version.
  $('appVersion').textContent = `v${chrome.runtime.getManifest().version}`;

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('fileInput').addEventListener('change', handleFileUpload);
  $('loadAnotherFileBtn').addEventListener('click', () => $('fileInput').click());
  $('newRecordBtn').addEventListener('click', startNewRecord);
  $('loginBtn').addEventListener('click', loginToSite);
  $('readBalancesBtn').addEventListener('click', readBudgetSourceBalances);
  $('apiRecToggleBtn').addEventListener('click', toggleApiRecording);
  $('apiRecExportBtn').addEventListener('click', exportApiTrafficLog);
  $('apiRecClearBtn').addEventListener('click', clearApiTrafficLog);
  $('apiTestBtn').addEventListener('click', testApiIdLookup);
  refreshApiRecorderUI();
  $('fillRequestBtn').addEventListener('click', () => runFillRequest());
  $('fillFromCurrentBtn').addEventListener('click', () => runFillFromCurrent());
  $('markSuccessBtn').addEventListener('click', () => overrideRequestStatus(STEP_STATUS.FILLED));
  $('markFailureBtn').addEventListener('click', () => overrideRequestStatus(STEP_STATUS.FAILED));
  $('prevRowBtn').addEventListener('click', () => navigateRow(-1));
  $('nextRowBtn').addEventListener('click', () => navigateRow(1));
  $('saveMappingBtn').addEventListener('click', saveMappingAndContinue);
  $('cancelMappingBtn').addEventListener('click', skipMappingAndContinue);
  $('mappingSiteValue').addEventListener('change', onMappingSiteValueChange);
  $('mappingAddSourceBtn').addEventListener('click', addSourceToList);
  $('fixMappingsBtn').addEventListener('click', fixMappings);
  $('exportBtn').addEventListener('click', exportSessionFile);
  $('rowFilter').addEventListener('change', (e) => {
    rowFilter = e.target.value;
    renderRowList();
  });

  // Each step button fills that step directly (merged "מלא שלב נוכחי" into the tabs).
  document.querySelectorAll('.step-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (automationRunning) return;
      const step = Number(tab.dataset.step);
      currentStep = step;
      updateStepTabs();
      fillCurrentStep(step);
    });
  });

  if (session?.parsedFile) restoreSession(session);
  refreshPageStatus();
}

/** Batches the operator-facing mapping queue (from pipeline.collectMappingQueue) into
 * one prompt per unique value; resolves once the whole queue is drained or skipped. */
function resolveMappingQueueInteractive(queue) {
  return new Promise((resolve) => {
    mappingQueue = [...queue];
    mappingResolveCallback = resolve;
    showNextQueueItem();
  });
}

function showNextQueueItem() {
  if (!mappingQueue.length) {
    hideMappingPrompt();
    const cb = mappingResolveCallback;
    mappingResolveCallback = null;
    cb?.();
    return;
  }
  pendingMapping = mappingQueue.shift();
  showMappingPrompt(pendingMapping);
}

/** Runs the fix+validate pipeline for every row using already-resolved mappings,
 * and merges with the previous session's progress when it's the same file. */
async function finalizeUpload(parsed, fileId, previousSession) {
  const { resolved } = await collectMappingQueue(parsed.rows, fileId, settings);
  const builtRows = parsed.rows.map((r) => buildRow(r, resolved, fileId));

  const sameFile = previousSession?.parsedFile?.fileId === fileId;
  const prevRequests = (sameFile && previousSession?.requests) || [];
  const newRowKeys = new Set(builtRows.map((r) => r.rowKey));

  // Rows already submitted ("already in") keep their previous split verbatim - we never
  // re-plan submitted work. They're frozen, excluded from re-allocation, and their budget
  // is already spent on the site (so not re-counted); any unfinished chunks of a frozen row
  // earmark budget below so fresh rows don't grab it.
  const committedRowKeys = new Set();
  for (const req of prevRequests) {
    if (isRequestDone(req)) committedRowKeys.add(req.rowKey);
  }
  const frozenRequests = prevRequests.filter(
    (req) => committedRowKeys.has(req.rowKey) && newRowKeys.has(req.rowKey)
  );

  // Current per-source remaining (as read from the home page), minus budget earmarked for
  // frozen rows' not-yet-submitted chunks.
  const remainingSnapshot = await getBudgetSourceRemaining();
  const pool = {};
  for (const [k, v] of Object.entries(remainingSnapshot)) {
    pool[normalizeText(k)] = (pool[normalizeText(k)] || 0) + (Number(v) || 0);
  }
  for (const req of frozenRequests) {
    if (isRequestDone(req) || req.outOfBudget) continue; // done => already deducted on the site
    const src = normalizeText(req.fields.budgetSourceSearch || '');
    if (src && pool[src] != null) pool[src] -= Math.round(Number(req.fields.amount) || 0);
  }

  // Re-plan only the rows without submitted work, against the earmarked pool. builtRows are
  // in Excel order (the allocator's consumption order).
  const freshRows = builtRows.filter((r) => !committedRowKeys.has(r.rowKey));
  const allocation = allocateSources(freshRows, pool);
  let freshRequests = buildAllRequests(freshRows, allocation);
  // Preserve partial (not-yet-submitted) step progress for fresh rows whose split is unchanged.
  freshRequests = mergeRequestsOnReupload(prevRequests, freshRequests);

  // Frozen (already-submitted) rows first so their positions stay stable, then the re-planned rows.
  const requests = [...frozenRequests, ...freshRequests];

  let droppedCount = 0;
  if (previousSession?.parsedFile?.rows) {
    droppedCount = mergeRowsOnReupload(previousSession.parsedFile.rows, builtRows).droppedCount;
  }

  const newSession = {
    parsedFile: { ...parsed, fileId, rows: builtRows, remainingSnapshot },
    requests,
    currentIndex: sameFile ? Math.min(previousSession.currentIndex ?? 0, requests.length - 1) : 0,
    log: previousSession?.log || [],
    startedAt: previousSession?.startedAt || new Date().toISOString(),
  };
  await saveSession(newSession);
  if (droppedCount) {
    log(`${droppedCount} שורות מהקובץ הקודם לא נמצאו בקובץ החדש והוסרו`);
    await persistLog();
  }
  return newSession;
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    const fileId = fileIdOf(file.name);
    const parsed = parseExcelBuffer(buffer, file.name);

    if (session?.parsedFile && session.parsedFile.fileId !== fileId) {
      const total = session.requests?.length ?? 0;
      const done = session.requests?.filter(isRequestDone).length ?? 0;
      const inProgress = done > 0 || (session.currentIndex ?? 0) > 0;
      if (inProgress) {
        const ok = confirm(
          `קובץ פעיל: ${session.parsedFile.fileName}\n` +
            `הושלמו ${done} מתוך ${total} שורות.\n\n` +
            `לטעון "${file.name}" במקום? ההתקדמות בקובץ הנוכחי תימחק.`
        );
        if (!ok) {
          e.target.value = '';
          return;
        }
      }
      resetForNewFile();
      session = null;
    }

    const { queue } = await collectMappingQueue(parsed.rows, fileId, settings);
    if (queue.length) await resolveMappingQueueInteractive(queue);

    session = await finalizeUpload(parsed, fileId, session);
    showFileUI(session);
    showCurrentRow();
    log(`נטען קובץ: ${session.requests.length} שורות, סה"כ ${formatCurrency(session.parsedFile.totalAmount)} ₪`);
    await persistLog();
  } catch (err) {
    alert(`Error loading file: ${err.message}`);
  } finally {
    e.target.value = '';
  }
}

/** Re-runs mapping resolution for the currently loaded file without needing a re-upload. */
async function fixMappings() {
  if (!session?.parsedFile) return;
  const { queue } = await collectMappingQueue(session.parsedFile.rows, session.parsedFile.fileId, settings);
  if (!queue.length) {
    log('אין מיפויים חסרים');
    await persistLog();
    return;
  }
  await resolveMappingQueueInteractive(queue);
  session = await finalizeUpload(session.parsedFile, session.parsedFile.fileId, session);
  showFileUI(session);
  showCurrentRow();
  log('מיפויים עודכנו');
  await persistLog();
}

function resetForNewFile() {
  hideMappingPrompt();
  currentStep = 1;
  updateStepTabs();
  $('fillLog').textContent = '';
}

function restoreSession(sess) {
  session = sess;
  showFileUI(session);
  showCurrentRow();
  $('fillLog').textContent = (session.log || [])
    .map((l) => `[${new Date(l.ts).toLocaleTimeString('he-IL')}] ${l.message}`)
    .join('\n');
}

function showFileUI(sess) {
  $('uploadSection').classList.add('hidden');
  $('navSection').classList.remove('hidden');
  $('fileInfo').classList.remove('hidden');
  $('progressSection').classList.remove('hidden');
  $('currentRowSection').classList.remove('hidden');
  $('rowListSection').classList.remove('hidden');

  const parsed = sess.parsedFile;
  $('fileName').textContent = parsed.fileName;
  $('cityName').textContent = parsed.city || parsed.cities.join(', ');
  $('rowCount').textContent = sess.requests.length;
  $('totalAmount').textContent = `${formatCurrency(parsed.totalAmount)} ₪`;

  const needsMapping = sess.requests.filter((r) => r.status === ROW_STATUS.NEEDS_MAPPING).length;
  const invalid = sess.requests.filter((r) => r.status === ROW_STATUS.INVALID).length;
  const outOfBudget = sess.requests.filter((r) => r.status === ROW_STATUS.OUT_OF_BUDGET).length;
  const issues = [
    invalid ? `${invalid} לא תקינות` : '',
    needsMapping ? `${needsMapping} דורשות מיפוי` : '',
    outOfBudget ? `${outOfBudget} חורגות מתקציב` : '',
  ].filter(Boolean);
  $('pipelineStatus').textContent =
    issues.length ? `⚠ ${issues.join(', ')}` : '✓ כל השורות מוכנות למילוי';

  const city = parsed.city;
  $('loginId').textContent = findCityLoginId(settings.cities, city) || '(not set – open Settings)';
  renderRowList();
  updateProgress();
}

function showCurrentRow() {
  if (!session?.requests?.length) return;
  const request = session.requests[session.currentIndex];
  if (!request) return;
  const f = request.fields;
  const errorsHtml = request.errors?.length ?
      `<div style="color:#c0392b">⚠ ${request.errors.map((e) => e.reason).join('; ')}</div>`
    : '';

  $('rowDetails').innerHTML = `
    <strong>${f.firstName || ''} ${f.lastName || ''}</strong> | ID ${f.idNumber || ''}<br>
    📞 ${f.mobilePhone || f.homePhone || ''} | 🎂 ${f.birthDate || ''} | ${f.maritalStatus || ''}<br>
    📍 ${f.street || ''} ${f.building || ''}, ${f.settlement || f.citySearch || ''}<br>
    <strong>Type:</strong> ${f.budgetSiteValue || ''} → ${f.itemSiteValue || ''}<br>
    <strong>מקור תקציב:</strong> ${
      request.outOfBudget ?
        `⚠ חורג מתקציב${request.sourceLabel ? ` (ימולא ל: ${request.sourceLabel})` : ''}`
      : request.sourceLabel || '—'
    }<br>
    <strong>Amount:</strong> ${formatCurrency(Number(f.amount) || 0)} ₪ | <em>${f.reason || ''}</em>
    ${errorsHtml}
  `;
  renderRowList();
  updateProgress();
}

function renderRowList() {
  const list = $('rowList');
  list.innerHTML = '';
  let shown = 0;
  session.requests.forEach((request, i) => {
    if (!matchesFilter(request)) return;
    shown += 1;
    const f = request.fields;
    const li = document.createElement('li');
    // Per-step glyph: ● filled, ✗ failed, ○ pending.
    const stepGlyphs = [1, 2, 3]
      .map((s) => (request.steps[s] === STEP_STATUS.FILLED ? '●' : request.steps[s] === STEP_STATUS.FAILED ? '✗' : '○'))
      .join('');
    const stepFailed = [1, 2, 3].some((s) => request.steps[s] === STEP_STATUS.FAILED);
    // Show "חלק k/n" when a row was split (over the item price limit or across budget sources).
    const splitTag = request.splitCount > 1 ? ` (חלק ${request.splitIndex + 1}/${request.splitCount})` : '';
    // The budget source funding this request (or an out-of-budget marker).
    const sourceTag =
      request.outOfBudget ? ' <span class="src-tag oob">חורג מתקציב</span>'
      : request.sourceLabel ? ` <span class="src-tag">${request.sourceLabel}</span>`
      : '';
    li.innerHTML =
      `${i + 1}. ${f.firstName || ''} ${f.lastName || ''} – ${formatCurrency(Number(f.amount) || 0)} ₪${splitTag}${sourceTag} [${stepGlyphs}]` +
      (request.errors?.length ? `<span class="row-error">${request.errors[0].reason}</span>` : '');
    if (isRequestDone(request)) li.classList.add('done');
    else if (request.status === ROW_STATUS.OUT_OF_BUDGET) li.classList.add('out-of-budget');
    else if (request.status === ROW_STATUS.INVALID) li.classList.add('invalid');
    else if (request.status === ROW_STATUS.NEEDS_MAPPING) li.classList.add('needs-mapping');
    else if (stepFailed) li.classList.add('step-failed');
    if (i === session.currentIndex) li.classList.add('active');
    li.addEventListener('click', () => {
      session.currentIndex = i;
      saveSession(session);
      showCurrentRow();
    });
    list.appendChild(li);
  });
  if (shown === 0) {
    const li = document.createElement('li');
    li.textContent = 'אין שורות בסינון זה';
    li.style.cursor = 'default';
    list.appendChild(li);
  }
}

function updateProgress() {
  const total = session.requests.length;
  const done = session.requests.filter(isRequestDone).length;
  $('progressFill').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progressText').textContent = `${done} / ${total} done | row ${session.currentIndex + 1}`;
}

function updateStepTabs() {
  document.querySelectorAll('.step-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.step) === currentStep);
  });
}

async function findAllFormFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function collectDocs(doc, out, seen) {
          if (!doc || seen.has(doc)) return;
          seen.add(doc);
          out.push(doc);
          for (const iframe of doc.querySelectorAll('iframe')) {
            try {
              if (iframe.contentDocument) collectDocs(iframe.contentDocument, out, seen);
            } catch (e) {}
          }
        }
        const docs = [];
        collectDocs(document, docs, new Set());
        const ids = { e199: 'mutav', e687: 'catalog', e305: 'whohowm', e25: 'home' };
        for (const doc of docs) {
          for (const [id, page] of Object.entries(ids)) {
            try {
              if (doc.getElementById(id)) return { page, id };
            } catch (e) {}
          }
        }
        return null;
      },
    });
    return results
      .filter((r) => r.result?.page)
      .map((r) => ({ frameId: r.frameId, page: r.result.page, id: r.result.id }));
  } catch {
    return [];
  }
}

async function getAllTabFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    const ids = [...new Set(results.map((r) => r.frameId))];
    return ids.length ? ids : [0];
  } catch {
    return [0];
  }
}

async function findFormFrame(tabId) {
  const frames = await findAllFormFrames(tabId);
  if (frames.length) return frames[0];

  const tab = await chrome.tabs.get(tabId);
  return { frameId: 0, page: pageFromTabUrl(tab?.url), url: tab?.url };
}

function pageFromTabUrl(url) {
  const u = (url || '').toUpperCase();
  if (u.includes('/MUTAV')) return 'mutav';
  if (u.includes('/CATALOG')) return 'catalog';
  if (u.includes('/WHOHOWM')) return 'whohowm';
  if (u.includes('IFCJAIDHOME')) return 'home';
  return 'unknown';
}

function resolvePageType({ tabUrl, msgUrl, msgPage }) {
  if (msgPage && msgPage !== 'unknown') return msgPage;
  const fromTab = pageFromTabUrl(tabUrl);
  if (fromTab !== 'unknown') return fromTab;
  return pageFromTabUrl(msgUrl);
}

async function ensureContentScript(tabId, frameId = 0) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId });
    return;
  } catch (e) {}

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/content.js'],
  });
  await new Promise((r) => setTimeout(r, 300));
}

async function getFormTitanTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.url?.includes('ifcjil.formtitan.com')) return active;

  const tabs = await chrome.tabs.query({ url: 'https://ifcjil.formtitan.com/*' });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[tabs.length - 1];
}

function scoreFillResponse(response, phase) {
  if (!response?.ok) return -1;
  const results = response.results || [];
  const idOk = results.some((r) => r.ok && (r.field === 'idNumber' || r.label === 'ת.ז.'));
  const lookupOk = results.some((r) => r.field === 'idLookup' && r.ok);
  const okCount = results.filter((r) => r.ok).length;
  if (phase === 'id') return (idOk ? 100 : 0) + (lookupOk ? 50 : 0) + okCount;
  return okCount + (response.filled ?? 0);
}

async function sendToContent(message) {
  const tab = await getFormTitanTab();
  if (!tab?.id) {
    throw new Error('No FormTitan tab – open ifcjil.formtitan.com and click the page');
  }

  await ensureContentScript(tab.id);

  const formFrames = await findAllFormFrames(tab.id);
  const detectedFrameIds = formFrames.length ? [...new Set(formFrames.map((f) => f.frameId))] : [];
  const allFrameIds = await getAllTabFrameIds(tab.id);
  const frameIds = detectedFrameIds.length ? detectedFrameIds : allFrameIds;

  async function sendOnce(frameId) {
    const response = await chrome.tabs.sendMessage(tab.id, message, { frameId });
    if (response === undefined) throw new Error('NO_RESPONSE');
    return response;
  }

  async function sendWithRetry(frameId) {
    try {
      return await sendOnce(frameId);
    } catch (err) {
      const msg = err?.message || '';
      if (
        !msg.includes('Receiving end does not exist') &&
        !msg.includes('Could not establish connection') &&
        msg !== 'NO_RESPONSE'
      ) {
        throw err;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/content.js'],
      });
      await new Promise((r) => setTimeout(r, 400));
      return await sendOnce(frameId);
    }
  }

  if (message.type === 'VERIFY_ID') {
    const tryOrder = [
      ...new Set([
        ...(lastWorkingFrameId != null ? [lastWorkingFrameId] : []),
        ...detectedFrameIds,
        ...allFrameIds,
      ]),
    ];
    for (const frameId of tryOrder) {
      try {
        const response = await sendWithRetry(frameId);
        if (response?.ok) {
          lastWorkingFrameId = frameId;
          return { ...response, frameId };
        }
      } catch (e) {}
    }
    return { ok: false };
  }

  if (message.type === 'CAPTURE_SOURCE_REMAINING') {
    // The budget-sources table lives in one of the form frames - probe them for the one
    // that actually finds it, rather than guessing a single frame.
    const tryOrder = [
      ...new Set([
        ...(lastWorkingFrameId != null ? [lastWorkingFrameId] : []),
        ...detectedFrameIds,
        ...allFrameIds,
      ]),
    ];
    for (const frameId of tryOrder) {
      try {
        const response = await sendWithRetry(frameId);
        if (response?.ok) {
          lastWorkingFrameId = frameId;
          return { ...response, frameId };
        }
      } catch (e) {}
    }
    return { ok: false, reason: 'table-not-found', remaining: {} };
  }

  if (message.type === 'FILL_STEP') {
    const tryOrder = [
      ...new Set([
        ...(lastWorkingFrameId != null ? [lastWorkingFrameId] : []),
        ...detectedFrameIds,
        ...allFrameIds,
      ]),
    ];
    let best = null;
    let bestScore = -1;
    let bestFrameId = null;

    for (const frameId of tryOrder) {
      try {
        const response = await sendWithRetry(frameId);
        const score = scoreFillResponse(response, message.phase);
        if (score > bestScore) {
          bestScore = score;
          best = response;
          bestFrameId = frameId;
        }
        const idFilled = response?.results?.some(
          (r) => r.ok && (r.field === 'idNumber' || r.label === 'ת.ז.')
        );
        const lookupOk = response?.results?.some((r) => r.field === 'idLookup' && r.ok);
        if (message.phase === 'id' && response?.ok && idFilled && lookupOk) {
          lastWorkingFrameId = frameId;
          return { ...response, frameId };
        }
        if (message.phase === 'details' && response?.ok && (response.filled > 0 || score > 0)) {
          lastWorkingFrameId = frameId;
          return { ...response, frameId };
        }
      } catch (e) {
        if (!best) best = { ok: false, error: e.message };
      }
    }

    if (bestFrameId != null && bestScore > 0) lastWorkingFrameId = bestFrameId;
    if (best) return { ...best, frameId: bestFrameId };
    throw new Error('Fill failed – form not found in any frame');
  }

  if (lastWorkingFrameId != null) {
    try {
      return { ...(await sendWithRetry(lastWorkingFrameId)), frameId: lastWorkingFrameId };
    } catch (e) {}
  }

  return sendWithRetry(frameIds[0]);
}

async function getPageInfoForTab() {
  const tab = await getFormTitanTab();
  if (!tab?.id) return { ok: false, error: 'no tab' };

  await ensureContentScript(tab.id);

  const allFrameIds = await getAllTabFrameIds(tab.id);
  let best = null;
  let errorPopup = null; // an error popup can be in any frame - surface it regardless

  for (const frameId of allFrameIds) {
    try {
      const msg = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'GET_PAGE_INFO' },
        { frameId }
      );
      if (!msg?.ok) continue;
      if (msg.errorPopup && !errorPopup) errorPopup = msg.errorPopup;
      const page = resolvePageType({ tabUrl: tab.url, msgUrl: msg.url, msgPage: msg.page });
      const info = {
        ...msg,
        page,
        url: tab.url || msg.url,
        frameId,
        detectedVia: 'content-script',
      };
      if (page === 'mutav' || msg.hasMutavForm) return { ...info, errorPopup: errorPopup || info.errorPopup };
      if (!best || (page !== 'unknown' && best.page === 'unknown')) best = info;
    } catch (e) {}
  }

  if (best) return { ...best, errorPopup: errorPopup || best.errorPopup };

  let frame;
  try {
    frame = await findFormFrame(tab.id);
  } catch (e) {
    frame = { frameId: 0, page: pageFromTabUrl(tab.url), url: tab.url };
  }

  return {
    ok: true,
    page: resolvePageType({ tabUrl: tab.url, msgUrl: frame.url, msgPage: frame.page }),
    url: tab.url || frame.url,
    frameId: frame.frameId ?? 0,
    marker: frame.id,
    detectedVia: 'frame-probe',
  };
}

const ADD_CATEGORY_OPTION = '__add_new_category__';

function showMappingPrompt(item) {
  $('mappingSection').classList.remove('hidden');
  $('mappingType').textContent = item.type;
  $('mappingExcelValue').textContent = item.excelValue;
  $('mappingAffectedCount').textContent = String(item.affectedRowKeys?.length ?? 0);

  const isSourceList = item.type === MAP_TYPES.budgetSource;
  const select = $('mappingSiteValue');
  const textInput = $('mappingSiteValueText');
  select.innerHTML = '';
  textInput.value = '';
  const suggestions = item.suggestions || [];

  // budgetSource always shows the picker (so the operator can build/extend the list even
  // when there are no suggestions yet); other types keep the plain select-or-text behavior.
  if (suggestions.length || isSourceList) {
    select.classList.remove('hidden');
    textInput.classList.add('hidden');
    suggestions.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    });
    // Let the operator add a brand-new category inline instead of only in Settings.
    const addOpt = document.createElement('option');
    addOpt.value = ADD_CATEGORY_OPTION;
    addOpt.textContent = '➕ הוסף קטגוריה חדשה…';
    select.appendChild(addOpt);
    if (!suggestions.length) {
      // Only the add-new option exists -> drop straight into free-text entry.
      select.value = ADD_CATEGORY_OPTION;
      textInput.classList.remove('hidden');
    }
  } else {
    select.classList.add('hidden');
    textInput.classList.remove('hidden');
  }

  // Ordered priority-list editor: budgetSource only.
  const wrap = $('mappingSourceListWrap');
  sourceListDraft = [];
  if (isSourceList) {
    wrap.classList.remove('hidden');
    renderSourceListDraft();
  } else {
    wrap.classList.add('hidden');
  }
}

/** Reads whatever the picker currently offers as a value (dropdown selection, or the
 * free-text input when "add new category" is active). Returns '' if nothing usable. */
function currentPickerValue() {
  const textInput = $('mappingSiteValueText');
  const usingText = !textInput.classList.contains('hidden');
  const value = usingText ? textInput.value.trim() : $('mappingSiteValue').value;
  return value === ADD_CATEGORY_OPTION ? '' : value;
}

/** When "add new category" is picked in the dropdown, reveal the free-text input so
 * the operator can type a value not yet in the list; it's saved as a category on save. */
function onMappingSiteValueChange() {
  const textInput = $('mappingSiteValueText');
  if ($('mappingSiteValue').value === ADD_CATEGORY_OPTION) {
    textInput.classList.remove('hidden');
    textInput.value = '';
    textInput.focus();
  } else {
    textInput.classList.add('hidden');
  }
}

function mkSourceBtn(text, onClick, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm source-btn';
  b.textContent = text;
  if (disabled) b.disabled = true;
  else b.addEventListener('click', onClick);
  return b;
}

function renderSourceListDraft() {
  const ol = $('mappingSourceList');
  ol.innerHTML = '';
  sourceListDraft.forEach((src, i) => {
    const li = document.createElement('li');
    li.className = 'source-list-item';
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = `${i + 1}. ${src}`;
    const up = mkSourceBtn('↑', () => moveSource(i, -1), i === 0);
    const down = mkSourceBtn('↓', () => moveSource(i, 1), i === sourceListDraft.length - 1);
    const rm = mkSourceBtn('✕', () => {
      sourceListDraft.splice(i, 1);
      renderSourceListDraft();
    });
    li.append(name, up, down, rm);
    ol.appendChild(li);
  });
}

function moveSource(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= sourceListDraft.length) return;
  [sourceListDraft[i], sourceListDraft[j]] = [sourceListDraft[j], sourceListDraft[i]];
  renderSourceListDraft();
}

/** Appends the picker's current value to the ordered list (deduped, case-insensitive). */
function addSourceToList() {
  const value = currentPickerValue();
  if (!value) {
    alert('בחר או הקלד מקור תקציב');
    return;
  }
  if (!sourceListDraft.some((s) => s.toLowerCase() === value.toLowerCase())) {
    sourceListDraft.push(value);
  }
  renderSourceListDraft();
  $('mappingSiteValueText').value = '';
}

function hideMappingPrompt() {
  pendingMapping = null;
  $('mappingSection').classList.add('hidden');
}

async function saveMappingAndContinue() {
  if (!pendingMapping) return;

  // budgetSource resolves to an ordered priority list. Anything left unadded in the picker
  // is folded in so the operator doesn't lose a value they typed but forgot to "+ הוסף".
  if (pendingMapping.type === MAP_TYPES.budgetSource) {
    const pending = currentPickerValue();
    if (pending && !sourceListDraft.some((s) => s.toLowerCase() === pending.toLowerCase())) {
      sourceListDraft.push(pending);
    }
    if (!sourceListDraft.length) {
      alert('הוסף לפחות מקור תקציב אחד');
      return;
    }
    await saveMapping(
      pendingMapping.type,
      pendingMapping.excelValue,
      sourceListDraft[0],
      pendingMapping.context || {},
      { siteValues: [...sourceListDraft] }
    );
    log(`נשמר מיפוי מקורות: ${pendingMapping.excelValue} → ${sourceListDraft.join(' › ')}`);
    showNextQueueItem();
    return;
  }

  // Use the free-text input whenever it's showing: either there were no suggestions,
  // or the operator picked "add new category" from the dropdown.
  const siteValue = currentPickerValue();

  if (!siteValue) {
    alert('Enter a site value');
    return;
  }

  const extra = {};
  if (pendingMapping.type === 'budgetType') {
    const idx = ['', 'סיוע חירום למשפחות', 'אזרחים ותיקים', 'ניצולי שואה', 'בתי משפט קהילתיים', 'של"מ', 'נפגעי אלימות במשפחה'].indexOf(siteValue);
    if (idx > 0) extra.labelIndex = idx;
  }
  if (pendingMapping.type === 'item') {
    extra.selector = siteValue;
  }

  await saveMapping(
    pendingMapping.type,
    pendingMapping.excelValue,
    siteValue,
    pendingMapping.context || {},
    extra
  );

  log(`נשמר מיפוי: ${pendingMapping.excelValue} → ${siteValue}`);
  showNextQueueItem();
}

function skipMappingAndContinue() {
  if (pendingMapping) log(`מיפוי דולג: ${pendingMapping.excelValue}`);
  showNextQueueItem();
}

async function fillCurrentStep(stepOverride) {
  const step = stepOverride || currentStep;
  const request = session.requests[session.currentIndex];

  try {
    const pageInfo = await getPageInfoForTab();
    const expectedPage = { 1: 'mutav', 2: 'catalog', 3: 'whohowm' }[step];

    if (!pageInfo?.ok) {
      log(`Connection error: ${pageInfo?.error || 'unknown'}. Reload FormTitan (F5).`);
      await persistLog();
      return;
    }

    const page =
      pageInfo.page && pageInfo.page !== 'unknown' ?
        pageInfo.page
      : pageFromTabUrl(pageInfo.url) || 'unknown';
    if (page !== expectedPage && page !== 'unknown') {
      log(`Warning: on ${page}, expected ${expectedPage}. Navigate first.`);
    } else if (page === 'unknown') {
      log(`Page not recognized (url: ${pageInfo.url}) – filling step ${step} anyway…`);
    } else {
      log(`Page: ${page}${pageInfo.frameId != null ? ` (frame ${pageInfo.frameId})` : ''}`);
    }

    if (!isFillable(request)) {
      log(`שורה זו דורשת תיקון (${request.status}): ${request.errors?.[0]?.reason || 'מיפוי חסר – השתמש ב"תקן מיפויים"'}`);
      await persistLog();
      return;
    }

    if (step === 1) log('Step 1: fill ID → search → fill remaining fields');

    const prepared = { ok: true, fields: request.fields, ...request.fields };
    const fillPayload = {
      type: 'FILL_STEP',
      step,
      prepared,
      selectors: settings.selectors,
      delayMs: settings.fillDelayMs,
      idLookupWaitMs: settings.idLookupWaitMs,
      searchWaitMs: settings.searchWaitMs || 1500,
    };

    let fieldsOk = false;
    if (step === 1) {
      log('Filling ID and clicking search…');
      const idResult = await sendToContent({ ...fillPayload, phase: 'id' });
      logFillResult(idResult, step);

      const idOk = idResult?.results?.some(
        (r) => r.ok && (r.field === 'idNumber' || r.label === 'ת.ז.')
      );
      const lookupOk = idResult?.results?.some((r) => r.field === 'idLookup' && r.ok);

      let canContinue = idOk && lookupOk;
      if (!canContinue) {
        const verify = await sendToContent({
          type: 'VERIFY_ID',
          idNumber: request.fields.idNumber,
          selectors: settings.selectors,
        });
        if (verify?.ok) {
          log(`ID verified on page (${verify.actual}) – continuing`);
          canContinue = true;
        }
      }

      if (!canContinue) {
        await setStepStatus(session, request.requestId, step, STEP_STATUS.FAILED);
        log('שלב 1 נכשל – ת.ז. או חיפוש נכשלו');
        return;
      }

      log('Filling remaining details…');
      const detailsResult = await sendToContent({ ...fillPayload, phase: 'details' });
      logFillResult(detailsResult, step);
      fieldsOk = allFieldsOk(detailsResult);
    } else {
      const result = await sendToContent(fillPayload);
      logFillResult(result, step);
      fieldsOk = allFieldsOk(result);
    }

    // An error popup during the field fill (e.g. a failed ID lookup) fails the stage
    // outright, with the popup's message. Exception: for של"מ budgets the under-18 age
    // warning is expected - confirm it ("תקון") and continue.
    const err = await currentErrorPopup();
    if (err) {
      const confirmed =
        isShalamRequest(request) && (await sendToContent({ type: 'CONFIRM_AGE_WARNING' }))?.confirmed;
      if (confirmed) {
        log('אושרה אזהרת גיל (שלמ) – ממשיך');
      } else {
        await setStepStatus(session, request.requestId, step, STEP_STATUS.FAILED);
        log(`שלב ${step} נכשל – הופיעה הודעת שגיאה: "${err}"`);
        return;
      }
    }

    await advanceStep(step, fieldsOk, request);
  } catch (err) {
    log(`Error: ${err.message}. Ensure FormTitan is the active tab.`);
  } finally {
    await persistLog();
    renderRowList();
    updateProgress();
  }
}

/** Completes a stage: verifies the fields succeeded, performs the site's advance
 * action (next/submit button, or nothing for CATALOG where the item click already
 * navigated), confirms the page actually moved to the expected next page, and only
 * then marks the stage FILLED. Anything short of that marks it FAILED. */
async function advanceStep(step, fieldsOk, request) {
  request = request || session.requests[session.currentIndex];
  const expected = EXPECTED_NEXT_PAGE[step];

  if (!fieldsOk) {
    await setStepStatus(session, request.requestId, step, STEP_STATUS.FAILED);
    log(`שלב ${step} נכשל – שדות לא מולאו כראוי, לא ממשיך`);
    return false;
  }

  // A page transition can take a while to land (the final submit especially), so we give
  // every stage the same generous budget. waitForStageOutcome polls and returns the moment
  // the page changes (or an error popup shows), so a fast transition never waits this long.
  const waitMs = settings.pageWaitMs || 20000;

  const stageOpts = { shalam: isShalamRequest(request) };

  // CATALOG has no next/submit button - selecting the item is what navigates.
  if (step === 2) {
    const outcome = await waitForStageOutcome(expected, waitMs, stageOpts);
    return finishStage(step, request, outcome, expected, 'לא עברנו ל-WhoHowM לאחר בחירת הפריט');
  }

  // MUTAV / WhoHowM: click next/submit, then require the page to change.
  const clickRes = await sendToContent({ type: 'CLICK_NEXT', step, selectors: settings.selectors });
  if (!clickRes?.ok) {
    await setStepStatus(session, request.requestId, step, STEP_STATUS.FAILED);
    log(`שלב ${step} נכשל – כפתור ${step === 1 ? 'הבא' : 'שליחה'} לא נמצא`);
    return false;
  }

  const outcome = await waitForStageOutcome(expected, waitMs, stageOpts);
  return finishStage(step, request, outcome, expected, `הדף לא עבר ל-${NEXT_PAGE_LABEL[expected]} אחרי הלחיצה`);
}

/** Marks a stage FILLED/FAILED from a waitForStageOutcome result - an error popup or a
 * missing navigation both count as failure (a popped-up error means the site rejected
 * the stage). Advances currentStep on success. */
async function finishStage(step, request, outcome, expected, timeoutReason) {
  if (outcome.navigated) {
    await setStepStatus(session, request.requestId, step, STEP_STATUS.FILLED);
    log(`שלב ${step} עבר – עברנו ל-${NEXT_PAGE_LABEL[expected]}`);
    if (step < 3) {
      currentStep = step + 1;
      updateStepTabs();
    }
    refreshPageStatus();
    return true;
  }

  await setStepStatus(session, request.requestId, step, STEP_STATUS.FAILED);
  if (outcome.error) {
    log(`שלב ${step} נכשל – הופיעה הודעת שגיאה: "${outcome.error}"`);
  } else {
    log(`שלב ${step} נכשל – ${timeoutReason}`);
  }
  refreshPageStatus();
  return false;
}

/** Reads the budget-source remaining balances from the home-page table, stores them, and
 * (if a file is loaded) re-plans the allocation so the row list reflects the fresh balances. */
async function readBudgetSourceBalances() {
  try {
    const res = await sendToContent({ type: 'CAPTURE_SOURCE_REMAINING', selectors: settings.selectors });
    if (!res?.ok) {
      log(`לא נקראו יתרות מקורות (${res?.reason || 'ודא שאתה בדף הבית עם טבלת הסעיפים'})`);
      await persistLog();
      return;
    }
    await saveBudgetSourceRemaining(res.remaining);
    const count = Object.keys(res.remaining).length;
    log(`נקראו ${count} יתרות מקורות תקציב מדף הבית`);

    if (session?.parsedFile) {
      session = await finalizeUpload(session.parsedFile, session.parsedFile.fileId, session);
      showFileUI(session);
      showCurrentRow();
      log('התקציבים חושבו מחדש עם היתרות המעודכנות');
    }
    await persistLog();
  } catch (err) {
    log(`שגיאה בקריאת יתרות: ${err.message}`);
    await persistLog();
  }
}

/** Dev tool: records the site's own API calls (via recorder-page/bridge content scripts)
 * so the request/response formats can be reverse-engineered for a request-based flow. */
async function refreshApiRecorderUI() {
  const { apiRecording, apiTrafficLog } = await chrome.storage.local.get(['apiRecording', 'apiTrafficLog']);
  $('apiRecToggleBtn').textContent = apiRecording ? '⏹ עצור הקלטה' : '⏺ התחל הקלטה';
  $('apiRecToggleBtn').classList.toggle('danger', Boolean(apiRecording));
  $('apiRecCount').textContent = `${(apiTrafficLog || []).length} קריאות`;
}

// Live-update the recorded-calls counter while the operator works on the site.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('apiTrafficLog' in changes || 'apiRecording' in changes)) {
    refreshApiRecorderUI().catch(() => {});
  }
});

async function toggleApiRecording() {
  const { apiRecording } = await chrome.storage.local.get('apiRecording');
  await chrome.storage.local.set({ apiRecording: !apiRecording });
  if (!apiRecording) log('הקלטת רשת החלה – בצע את התהליך באתר (רענן את הדף אם היה פתוח)');
  else log('הקלטת רשת נעצרה');
  await refreshApiRecorderUI();
}

async function exportApiTrafficLog() {
  const { apiTrafficLog } = await chrome.storage.local.get('apiTrafficLog');
  if (!apiTrafficLog?.length) {
    alert('אין קריאות מוקלטות');
    return;
  }
  const blob = new Blob([JSON.stringify(apiTrafficLog, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `api-traffic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearApiTrafficLog() {
  await chrome.storage.local.remove('apiTrafficLog');
  await refreshApiRecorderUI();
}

/** Phase 0 spike: prove we can replay the harvested session headers by doing the ID lookup
 * ourselves (get/sfmapping) and showing what comes back. */
async function testApiIdLookup() {
  const { ftAuth } = await chrome.storage.local.get('ftAuth');
  if (!ftAuth?.headers) {
    log('אין כותרות אימות שנלכדו – פתח/רענן את אתר FormTitan ובצע פעולה כלשהי, ואז נסה שוב');
    return;
  }
  const suggested = session?.requests?.[session.currentIndex]?.fields?.idNumber || '';
  const id = prompt('ת.ז. לבדיקת API (ID lookup):', suggested);
  if (!id) return;
  try {
    const req = await buildIdLookupRequest(id.trim());
    const res = await sendToContent({ type: 'API_FETCH', request: req });
    if (!res?.ok) {
      log(`API נכשל: ${res?.error || 'status ' + res?.status}`);
      return;
    }
    if (isAuthFailure(res.status, res.text)) {
      log('נראה שהסשן פג – לחץ "🔑 התחבר" והתחבר מחדש');
      return;
    }
    const parsed = parseMappingResponse(res.text);
    log(`API ${res.status}: status=${parsed.status} | ${Object.keys(parsed.fields || {}).length} שדות, ${Object.keys(parsed.params || {}).length} params`);
    log(JSON.stringify(parsed.fields).slice(0, 600));
  } catch (e) {
    log(`שגיאה: ${e.message}`);
  }
  await persistLog();
}

/** Picks which city's credentials to log in with: the current file's city, else the only
 * configured one, else asks the operator to choose. Returns { city, loginId, password } or null. */
async function pickLoginCredentials() {
  const creds = await getCityCredentials();
  const configured = Object.keys(creds).filter((c) => creds[c]);
  if (!configured.length) {
    alert('לא הוגדרו סיסמאות. הזן ת.ז. וסיסמה לכל עיר בהגדרות.');
    return null;
  }
  let city = null;
  const fileCity = session?.parsedFile?.city;
  if (fileCity) {
    city = configured.find((c) => normalizeCity(c) === normalizeCity(fileCity)) || null;
  }
  if (!city) city = configured.length === 1 ? configured[0] : null;
  if (!city) {
    const choice = prompt(`עבור איזו עיר להתחבר?\n${configured.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
    const idx = Number(choice) - 1;
    city = configured[idx] || configured.find((c) => c === (choice || '').trim());
  }
  if (!city) return null;
  // Reload settings from storage - the side panel keeps its `settings` from when it opened,
  // so a login id saved afterward wouldn't be visible in the cached copy.
  settings = await loadSettings();
  const loginId = findCityLoginId(settings.cities, city) || settings.cities?.[city]?.loginId || '';
  if (!loginId) {
    alert(`אין ת.ז. התחברות לעיר ${city} – הגדר בהגדרות (ולחץ "שמור הגדרות").`);
    return null;
  }
  return { city, loginId, password: creds[city] };
}

/** Logs in to FormTitan via the 2-step SMS flow using stored credentials, and stores the
 * resulting session tokens (ftAuth) for direct API calls. */
async function loginToSite() {
  const cred = await pickLoginCredentials();
  if (!cred) return;
  try {
    log(`מבקש קוד SMS עבור ${cred.city}…`);
    const r1 = await sendToContent({ type: 'API_FETCH', request: buildSmsRequest(cred.loginId, cred.password) });
    if (!r1?.ok) {
      log(`בקשת SMS נכשלה: ${r1?.error || 'status ' + r1?.status}`);
      await persistLog();
      return;
    }
    const code = prompt('הזן את קוד ה-SMS שקיבלת:');
    if (!code) return;
    const r2 = await sendToContent({ type: 'API_FETCH', request: buildVerifyRequest(cred.loginId, cred.password, code.trim()) });
    if (!r2?.ok) {
      log(`אימות נכשל: ${r2?.error || 'status ' + r2?.status}`);
      await persistLog();
      return;
    }
    const parsed = parseVerifyResponse(r2.text);
    if (!parsed.ok) {
      log(`התחברות נכשלה: ${parsed.error}`);
      await persistLog();
      return;
    }
    await chrome.storage.local.set({ ftAuth: parsed.auth });
    log(`✓ התחברות הצליחה (${cred.city}) – טוקן הסשן נשמר`);
    // The verify call ran same-origin with credentials, so the session cookie is now set in
    // the browser. Reload the FormTitan tab so the GUI picks up the logged-in session.
    const tab = await getFormTitanTab();
    if (tab?.id) {
      await chrome.tabs.reload(tab.id);
      log('רועננתי את דף האתר כדי שיתחבר אוטומטית');
    } else {
      log('אין טאב של FormTitan פתוח – פתח את האתר כדי לראות את ההתחברות');
    }
  } catch (e) {
    log(`שגיאה בהתחברות: ${e.message}`);
  }
  await persistLog();
}

async function startNewRecord() {
  try {
    const result = await sendToContent({ type: 'START_NEW_RECORD', selectors: settings.selectors });
    if (result.ok) {
      log('Clicked new record – wait for MUTAV page');
      setTimeout(refreshPageStatus, 1500);
    } else {
      log('New record button not found – go to home page first');
    }
  } catch (err) {
    log(`Error: ${err.message}`);
  }
}

/** Navigates the FormTitan tab to the home page and waits for it to load. */
async function goHome() {
  const tab = await getFormTitanTab();
  if (!tab?.id) {
    log('אין טאב של FormTitan פתוח');
    return false;
  }
  await chrome.tabs.update(tab.id, { url: SITE.homeUrl });
  const atHome = await waitForPageChange('home', 12000);
  if (!atHome) log('לא הצלחנו להגיע לדף הבית');
  return atHome;
}

/** Clicks "רשומה חדשה" and waits for the MUTAV form. Retries the click, because
 * right after force-navigating to home the page's handlers may not be attached yet,
 * so the first click can land too early and do nothing (the standalone button works
 * because the operator clicks a page that has already settled). */
async function newRecordAndWaitMutav() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1000)); // let the home page hydrate
    const nr = await sendToContent({ type: 'START_NEW_RECORD', selectors: settings.selectors });
    if (!nr?.ok) {
      log(`ניסיון ${attempt}: כפתור "רשומה חדשה" לא נמצא${nr?.error ? ` (${nr.error})` : ''}`);
      continue;
    }
    if (await waitForPageChange('mutav', 6000)) return true;
    const info = await getPageInfoForTab();
    // Still on home means the click didn't register (too early) - loop and retry.
    if (info?.page !== 'home' && (await waitForPageChange('mutav', 4000))) return true;
    log(`ניסיון ${attempt}: עדיין לא ב-MUTAV (הדף: ${info?.page || '?'}) – מנסה שוב`);
  }
  const info = await getPageInfoForTab();
  log(`הטופס (MUTAV) לא נטען אחרי "רשומה חדשה" (הדף כרגע: ${info?.page || '?'} ${info?.url || ''})`);
  return false;
}

/** Fills the request at session.currentIndex end to end: home → new record → fill
 * stages 1,2,3 in order. Stops at the first stage that doesn't pass (leaving the
 * operator on it). Returns { ok, stoppedAt (0 = success), needsFix }. */
async function fillOneRequest() {
  const request = session.requests[session.currentIndex];
  if (!request) return { ok: false, stoppedAt: 1 };
  if (!isFillable(request)) {
    log(`בקשה ${session.currentIndex + 1} דורשת תיקון (${request.status}) – מדלג`);
    return { ok: false, stoppedAt: 1, needsFix: true };
  }

  const f = request.fields;
  log(`— בקשה ${session.currentIndex + 1}: ${f.firstName || ''} ${f.lastName || ''} —`);
  if (stopRequested) return { ok: false, stoppedAt: 1, stopped: true };
  if (!(await goHome())) return { ok: false, stoppedAt: 1 };
  if (stopRequested) return { ok: false, stoppedAt: 1, stopped: true };
  if (!(await newRecordAndWaitMutav())) return { ok: false, stoppedAt: 1 };

  for (const step of [1, 2, 3]) {
    if (stopRequested) return { ok: false, stoppedAt: step, stopped: true };
    currentStep = step;
    updateStepTabs();
    await fillCurrentStep(step);
    const req = session.requests[session.currentIndex];
    if (req.steps[step] !== STEP_STATUS.FILLED) {
      log(`בקשה ${session.currentIndex + 1} נעצרה בשלב ${step} – יש להשלים ידנית`);
      return { ok: false, stoppedAt: step };
    }
  }
  log(`בקשה ${session.currentIndex + 1} הושלמה בהצלחה`);
  return { ok: true, stoppedAt: 0 };
}

/** Disables the manual controls during automation; the batch button doubles as a
 * "stop" toggle while a batch is running. */
function setAutomationRunning(on, batch = false) {
  automationRunning = on;
  ['newRecordBtn', 'fillRequestBtn', 'prevRowBtn', 'nextRowBtn', 'markSuccessBtn', 'markFailureBtn'].forEach(
    (id) => {
      const b = $(id);
      if (b) b.disabled = on;
    }
  );
  document.querySelectorAll('.step-tab').forEach((tab) => {
    tab.disabled = on;
  });
  const batchBtn = $('fillFromCurrentBtn');
  if (batchBtn) {
    if (batch) {
      batchBtn.disabled = false;
      batchBtn.textContent = on ? '■ עצור' : 'מלא בקשות מהנוכחית';
    } else {
      batchBtn.disabled = on;
    }
  }
}

/** Button 1 — "מלא בקשה": fill only the current request, stopping on the first error
 * so the operator can finish that stage manually. */
async function runFillRequest() {
  if (automationRunning) return;
  setAutomationRunning(true);
  try {
    const result = await fillOneRequest();
    if (!result.ok && result.stoppedAt) {
      currentStep = result.stoppedAt; // leave the operator on the failing stage
      updateStepTabs();
    }
  } catch (err) {
    log(`שגיאה: ${err.message}`);
  } finally {
    setAutomationRunning(false);
    await persistLog();
    showCurrentRow();
    renderRowList();
    updateProgress();
    refreshPageStatus();
  }
}

/** Button 2 — "מלא בקשות מהנוכחית": fill every request from the current one onward.
 * Unlike button 1, an errored request is left marked failed and the run continues to
 * the next request (going home to abandon the partial one). Click again to stop. */
async function runFillFromCurrent() {
  if (automationRunning) {
    stopRequested = true;
    const btn = $('fillFromCurrentBtn');
    if (btn) {
      btn.textContent = '⏳ עוצר…';
      btn.disabled = true;
    }
    log('בקשת עצירה…');
    return;
  }
  stopRequested = false;
  setAutomationRunning(true, true);
  try {
    const filterLabels = {
      undone: 'רק שלא הושלמו',
      failed: 'רק שנכשלו',
      needsfix: 'רק שדורשות תיקון',
      outofbudget: 'רק חורגות מתקציב',
    };
    if (filterLabels[rowFilter]) log(`מסנן פעיל: ${filterLabels[rowFilter]}`);
    const start = session.currentIndex;
    for (let i = start; i < session.requests.length; i++) {
      if (stopRequested) break;
      // Respect the row-list filter - the batch only runs on requests it matches.
      if (!matchesFilter(session.requests[i])) continue;
      // Out-of-budget requests are only filled on demand via "מלא בקשה", never in the batch.
      if (session.requests[i].status === ROW_STATUS.OUT_OF_BUDGET) {
        log(`בקשה ${i + 1} חורגת מתקציב – מדלג בריצת אצווה`);
        continue;
      }
      session.currentIndex = i;
      currentStep = 1;
      await saveSession(session);
      showCurrentRow();

      if (isRequestDone(session.requests[i])) {
        log(`בקשה ${i + 1} כבר הושלמה – מדלג`);
        continue;
      }

      const result = await fillOneRequest();
      if (result.stopped) break; // stop was requested mid-request
      if (!result.ok) {
        // The failing stage is already marked FAILED; abandon the partial request
        // on the site and move on (unless it was an unfillable/invalid row).
        log(`בקשה ${i + 1} לא הושלמה – ממשיך לבקשה הבאה`);
        if (!result.needsFix) await goHome();
      }
    }
    log(stopRequested ? 'הופסק ע"י המפעיל' : '— סיום מילוי הבקשות —');
  } catch (err) {
    log(`שגיאה: ${err.message}`);
  } finally {
    stopRequested = false;
    setAutomationRunning(false, true);
    await persistLog();
    showCurrentRow();
    renderRowList();
    updateProgress();
    refreshPageStatus();
  }
}

/** Manual override: force all three stages of the current request to one status
 * (FILLED = mark the whole row as success, FAILED = mark it as failure), for when
 * the automatic detection got it wrong. */
async function overrideRequestStatus(status) {
  if (automationRunning) return;
  const request = session.requests[session.currentIndex];
  if (!request) return;
  for (const step of [1, 2, 3]) {
    await setStepStatus(session, request.requestId, step, status);
  }
  log(
    status === STEP_STATUS.FILLED
      ? `בקשה ${session.currentIndex + 1} סומנה ידנית כהצלחה`
      : `בקשה ${session.currentIndex + 1} סומנה ידנית ככישלון`
  );
  await persistLog();
  showCurrentRow();
  renderRowList();
  updateProgress();
}

function navigateRow(delta) {
  const next = session.currentIndex + delta;
  if (next >= 0 && next < session.requests.length) {
    session.currentIndex = next;
    saveSession(session);
    showCurrentRow();
    currentStep = 1;
    updateStepTabs();
  }
}

async function refreshPageStatus() {
  const el = $('pageStatus');
  if (!el) return;
  try {
    const info = await getPageInfoForTab();
    const labels = {
      home: 'Home – click New Record',
      mutav: 'MUTAV – fill step 1',
      catalog: 'CATALOG – fill step 2',
      whohowm: 'WhoHowM – fill step 3',
      unknown: 'FormTitan – page unknown',
    };
    if (info?.ok && info.page) {
      el.textContent = `✓ ${labels[info.page] || info.url}${info.frameId != null ? ` [frame ${info.frameId}]` : ''}`;
    } else {
      el.textContent = info?.url || 'Connected – reload page if fill fails';
    }
  } catch {
    el.textContent = 'Open FormTitan (ifcjil.formtitan.com) in a browser tab';
  }
}

/** Builds an .xlsx (processed table + log) the operator can open outside the extension. */
function exportSessionFile() {
  if (!session?.requests?.length) {
    alert('אין נתונים לייצוא');
    return;
  }
  const tableRows = session.requests.map((r, i) => ({
    '#': i + 1,
    status: r.status,
    step1: r.steps[1],
    step2: r.steps[2],
    step3: r.steps[3],
    errors: (r.errors || []).map((e) => `${e.field}: ${e.reason}`).join('; '),
    ...r.fields,
  }));
  let logRows = (session.log || []).map((l) => ({ time: l.ts, message: l.message }));
  if (!logRows.length) {
    // Fall back to the on-screen log (one entry per line) so the Log sheet reflects
    // what the operator actually saw, even if session.log wasn't populated.
    logRows = ($('fillLog').textContent || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => ({ time: '', message: line }));
  }
  if (!logRows.length) logRows = [{ time: '', message: '(אין יומן)' }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tableRows), 'Requests');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows), 'Log');
  const safeName = (session.parsedFile.fileName || 'export').replace(/\.xlsx?$/i, '');
  XLSX.writeFile(wb, `${safeName}_export.xlsx`);
}

function logFillResult(result, step) {
  if (!result?.ok && result?.error) {
    log(`Fill error: ${result.error}`);
  }
  if (result?.results?.length) {
    log(`Step ${step} (${result.stepName || STEP_PAGES[step]}): ${result.filled}/${result.total} fields`);
    result.results.forEach((r) => {
      if (r.skipped) log(`  ⊘ ${r.label || r.field} – locked: "${r.value}"`);
      else log(`  ${r.ok ? '✓' : '✗'} ${r.label || r.field} = ${r.value ?? ''}${r.reason ? ` (${r.reason})` : ''}`);
    });
  } else if (result?.ok) {
    log(`Step ${step} completed but no field details returned`);
  }
}

/** Updates the on-screen log and the in-memory session.log; call persistLog() to save. */
function log(msg) {
  const el = $('fillLog');
  const ts = new Date().toISOString();
  el.textContent = `[${new Date(ts).toLocaleTimeString('he-IL')}] ${msg}\n` + el.textContent;
  if (session) {
    session.log = session.log || [];
    session.log.unshift({ ts, message: msg });
    // Cap the log so a long batch can't grow it past the storage quota (which would
    // make saveSession fail and drop the log on the next popup open).
    if (session.log.length > 3000) session.log.length = 3000;
  }
}

async function persistLog() {
  if (session) await saveSession(session);
}

init();
