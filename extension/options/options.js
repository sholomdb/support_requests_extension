import { loadSettings, saveSettings } from '../shared/config.js';
import {
  listMappingsFlat,
  deleteMapping,
  saveMapping,
  MAP_TYPES,
  getSuggestions,
  addCategory,
  removeCategory,
  HARDCODED_SUGGESTIONS,
  setItemInfo,
  exportMappingData,
  importMappingData,
} from '../shared/mappings.js';

const TYPE_LABELS = {
  [MAP_TYPES.city]: 'עיר',
  [MAP_TYPES.budgetType]: 'סוג תקציב',
  [MAP_TYPES.item]: 'פריט',
  [MAP_TYPES.budgetSource]: 'מקור תקציב',
  [MAP_TYPES.birthCountry]: 'ארץ לידה',
  [MAP_TYPES.familyClassification]: 'סיווג משפחה',
};

/** Escapes text used inside an HTML attribute built via a template literal - values
 * like "של"מ" or "אש"ל חב"ד ירושלים" contain a literal `"` (Hebrew גרשיים) that would
 * otherwise close the attribute early and truncate the rendered value. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let settings = null;

async function init() {
  settings = await loadSettings();
  renderCities();
  await renderCategories();
  await renderMappings();
  document.getElementById('siteUrl').value = settings.siteUrl || '';
  document.getElementById('fillDelayMs').value = settings.fillDelayMs || 400;
  document.getElementById('idLookupWaitMs').value = settings.idLookupWaitMs || 2000;
  document.getElementById('searchWaitMs').value = settings.searchWaitMs || 1500;

  document.getElementById('saveBtn').addEventListener('click', saveAll);
  document.getElementById('addCityBtn').addEventListener('click', addCity);
  document.getElementById('exportSettingsBtn').addEventListener('click', exportSettings);
  document.getElementById('importSettingsInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importSettingsFile(file);
    e.target.value = '';
  });
  document.getElementById('refreshMappingsBtn').addEventListener('click', async () => {
    await renderCategories();
    await renderMappings();
  });
}

function renderCities() {
  const container = document.getElementById('citiesContainer');
  container.innerHTML = '';
  for (const [name, cfg] of Object.entries(settings.cities)) {
    container.appendChild(createCityRow(name, cfg.loginId || ''));
  }
}

function createCityRow(name, loginId) {
  const row = document.createElement('div');
  row.className = 'city-row';
  row.innerHTML = `
    <label>שם עיר<input type="text" class="city-name" value="${escapeHtml(name)}" /></label>
    <label>ת.ז. התחברות<input type="text" class="city-login" value="${escapeHtml(loginId)}" /></label>
    <button class="btn remove-city">✕</button>
  `;
  row.querySelector('.remove-city').addEventListener('click', () => row.remove());
  return row;
}

function addCity() {
  document.getElementById('citiesContainer').appendChild(createCityRow('', ''));
}

async function renderCategories() {
  const container = document.getElementById('categoriesContainer');
  if (!container) return;
  container.innerHTML = '';

  for (const type of Object.values(MAP_TYPES)) {
    const block = document.createElement('div');
    block.className = 'category-block';
    const values = await getSuggestions(type);
    const builtIn = new Set((HARDCODED_SUGGESTIONS[type] || []).map((v) => v.toLowerCase()));

    const chips = values
      .map((v) => {
        const removeBtn = builtIn.has(v.toLowerCase())
          ? ''
          : `<button data-type="${escapeHtml(type)}" data-value="${escapeHtml(v)}" title="הסר">✕</button>`;
        return `<span class="category-chip">${escapeHtml(v)}${removeBtn}</span>`;
      })
      .join('');

    block.innerHTML = `
      <h3>${escapeHtml(TYPE_LABELS[type] || type)}</h3>
      <div class="category-chips">${chips || '<span class="hint">אין קטגוריות עדיין</span>'}</div>
      <div class="category-add">
        <input type="text" class="category-input" placeholder="הוסף קטגוריה חדשה" />
        <button class="btn btn-sm category-add-btn">+ הוסף</button>
      </div>
    `;

    block.querySelectorAll('.category-chip button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removeCategory(btn.dataset.type, btn.dataset.value);
        await renderCategories();
      });
    });

    const input = block.querySelector('.category-input');
    block.querySelector('.category-add-btn').addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      await addCategory(type, value);
      await renderCategories();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') block.querySelector('.category-add-btn').click();
    });

    container.appendChild(block);
  }
}

async function renderMappings() {
  const tbody = document.getElementById('mappingsBody');
  if (!tbody) return;
  const rows = await listMappingsFlat();
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5">אין מיפויים שמורים</td></tr>';
    return;
  }
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const captureBtn = row.type === 'item' ? '<button class="btn btn-sm capture-map">לכוד סלקטור</button> ' : '';
    tr.innerHTML = `
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.excelValue || row.key)}</td>
      <td><input type="text" class="map-site-value" data-type="${escapeHtml(row.type)}" data-key="${escapeHtml(row.key)}" value="${escapeHtml(row.siteValue || '')}" /></td>
      <td>${escapeHtml(row.labelIndex || row.selector || '')}</td>
      <td>${captureBtn}<button class="btn btn-sm save-map">שמור</button> <button class="btn btn-sm delete-map">מחק</button></td>
    `;
    tr.querySelector('.save-map').addEventListener('click', async () => {
      const input = tr.querySelector('.map-site-value');
      await saveMapping(row.type, row.excelValue || row.key, input.value.trim(), row.context || {});
      await renderMappings();
    });
    tr.querySelector('.delete-map').addEventListener('click', async () => {
      await deleteMapping(row.type, row.excelValue || row.key, row.context || {});
      await renderMappings();
    });
    tr.querySelector('.capture-map')?.addEventListener('click', () => captureItemSelector(row));
    tbody.appendChild(tr);
  });
}

/** Arms a one-time click-to-capture on the active FormTitan tab, since each catalog
 * item is its own DOM element (no shared selector) - see docs/PIPELINE.md. */
async function captureItemSelector(row) {
  const [tab] = await chrome.tabs.query({ url: 'https://ifcjil.formtitan.com/*' });
  if (!tab?.id) {
    alert('פתח את האתר (FormTitan) בכרטיסייה לפני הלכידה');
    return;
  }
  document.getElementById('saveStatus').textContent = 'לחץ על הפריט באתר תוך 30 שניות…';
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'ARM_ITEM_CAPTURE', timeoutMs: 30000 });
    if (!result?.ok || !result.selector) {
      alert('לא נלכד סלקטור (פג הזמן או לחיצה על אלמנט ללא id)');
      return;
    }
    await saveMapping(row.type, row.excelValue || row.key, result.text || row.siteValue, row.context || {}, {
      selector: result.selector,
    });

    const priceInput = prompt('מחיר מירבי לפריט זה (ריק אם לא ידוע):', '');
    const maxPrice = priceInput ? Number(priceInput.replace(/[^\d.]/g, '')) : undefined;
    if (maxPrice) await setItemInfo(result.text || row.siteValue, { selector: result.selector, maxPrice });

    document.getElementById('saveStatus').textContent = `✓ נלכד: ${result.selector}`;
    await renderMappings();
  } catch (err) {
    alert(`שגיאה בלכידה: ${err.message}`);
  } finally {
    setTimeout(() => {
      document.getElementById('saveStatus').textContent = '';
    }, 3000);
  }
}

function collectCities() {
  const cities = {};
  document.querySelectorAll('.city-row').forEach((row) => {
    const name = row.querySelector('.city-name').value.trim();
    const loginId = row.querySelector('.city-login').value.trim();
    if (name) cities[name] = { loginId, notes: '' };
  });
  return cities;
}

async function saveAll() {
  settings.cities = collectCities();
  settings.siteUrl = document.getElementById('siteUrl').value.trim();
  settings.fillDelayMs = Number(document.getElementById('fillDelayMs').value) || 400;
  settings.idLookupWaitMs = Number(document.getElementById('idLookupWaitMs').value) || 2000;
  settings.searchWaitMs = Number(document.getElementById('searchWaitMs').value) || 1500;
  // Selectors are defined in code (config.js DEFAULT_SELECTORS) only, not editable
  // here - drop any override left over from before, so code defaults always win.
  delete settings.selectors;
  await saveSettings(settings);
  document.getElementById('saveStatus').textContent = '✓ נשמר';
  setTimeout(() => {
    document.getElementById('saveStatus').textContent = '';
  }, 2000);
}

/** Settings export/import covers cities + general timing settings + all
 * operator-taught data (mappings, categories, captured item selectors/prices).
 * Selectors are excluded - they're code-only now. */
async function exportSettings() {
  try {
    const data = {
      cities: settings.cities,
      siteUrl: settings.siteUrl,
      fillDelayMs: settings.fillDelayMs,
      idLookupWaitMs: settings.idLookupWaitMs,
      searchWaitMs: settings.searchWaitMs,
      ...(await exportMappingData()),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'assist-request-filler-settings.json';
    // Must be in the DOM for the synthetic click to trigger a download in some
    // Chrome versions - a detached anchor can silently no-op.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('saveStatus').textContent = '✓ הורדו הגדרות';
    setTimeout(() => {
      document.getElementById('saveStatus').textContent = '';
    }, 2000);
  } catch (err) {
    alert(`שגיאה בהורדת ההגדרות: ${err.message}`);
  }
}

async function importSettingsFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.cities) settings.cities = data.cities;
    if (data.siteUrl !== undefined) settings.siteUrl = data.siteUrl;
    if (data.fillDelayMs !== undefined) settings.fillDelayMs = data.fillDelayMs;
    if (data.idLookupWaitMs !== undefined) settings.idLookupWaitMs = data.idLookupWaitMs;
    if (data.searchWaitMs !== undefined) settings.searchWaitMs = data.searchWaitMs;

    // Mappings, categories, and captured item info (chrome.storage.local).
    await importMappingData(data);

    renderCities();
    await renderCategories();
    await renderMappings();
    document.getElementById('siteUrl').value = settings.siteUrl || '';
    document.getElementById('fillDelayMs').value = settings.fillDelayMs || 400;
    document.getElementById('idLookupWaitMs').value = settings.idLookupWaitMs || 2000;
    document.getElementById('searchWaitMs').value = settings.searchWaitMs || 1500;

    delete settings.selectors;
    await saveSettings(settings);
    document.getElementById('saveStatus').textContent = '✓ הגדרות נטענו ונשמרו';
  } catch (err) {
    alert(`שגיאה בטעינת קובץ ההגדרות: ${err.message}`);
  } finally {
    setTimeout(() => {
      document.getElementById('saveStatus').textContent = '';
    }, 3000);
  }
}

// Guarded so this module can be imported in a non-browser context (unit tests)
// without executing the browser-only init flow.
if (typeof document !== 'undefined') init();
