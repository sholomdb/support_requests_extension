import { loadSettings, saveSettings, BUDGET_LABELS } from '../shared/config.js';
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
  getBudgetSourceList,
  migrateBudgetSourceToLabelKeys,
} from '../shared/mappings.js';
import { getBudgetSourceRemaining, saveBudgetSourceRemaining } from '../shared/storage.js';

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
  await migrateBudgetSourceToLabelKeys();
  renderCities();
  await renderCategories();
  await renderBudgetSourceLists();
  await renderBudgetBalances();
  await renderMappings();
  document.getElementById('siteUrl').value = settings.siteUrl || '';
  document.getElementById('fillDelayMs').value = settings.fillDelayMs || 400;
  document.getElementById('idLookupWaitMs').value = settings.idLookupWaitMs || 2000;
  document.getElementById('searchWaitMs').value = settings.searchWaitMs || 1500;
  document.getElementById('pageWaitMs').value = settings.pageWaitMs || 20000;

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
  document.getElementById('refreshBudgetSourcesBtn').addEventListener('click', async () => {
    await renderBudgetSourceLists();
    await renderBudgetBalances();
  });
}

/** Small square action button (↑ ↓ ✕ etc.) used by the budget-source editors. */
function miniBtn(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** One editable ordered budget-source list for a (site budget label, city) combo. */
function createBudgetSourceListBlock(budgetLabel, city, initialList) {
  const list = [...initialList];

  const block = document.createElement('div');
  block.className = 'bs-block';

  const heading = document.createElement('h4');
  heading.className = 'bs-combo-heading';
  heading.textContent = budgetLabel;

  const ol = document.createElement('ol');
  ol.className = 'source-list';

  const status = document.createElement('span');
  status.className = 'hint bs-status';

  const renderList = () => {
    ol.innerHTML = '';
    list.forEach((src, i) => {
      const li = document.createElement('li');
      li.className = 'source-list-item';
      const name = document.createElement('span');
      name.className = 'source-name';
      name.textContent = `${i + 1}. ${src}`;
      const up = miniBtn('↑', () => {
        if (i > 0) {
          [list[i - 1], list[i]] = [list[i], list[i - 1]];
          renderList();
        }
      });
      const down = miniBtn('↓', () => {
        if (i < list.length - 1) {
          [list[i + 1], list[i]] = [list[i], list[i + 1]];
          renderList();
        }
      });
      const rm = miniBtn('✕', () => {
        list.splice(i, 1);
        renderList();
      });
      li.append(name, up, down, rm);
      ol.appendChild(li);
    });
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = 'הרשימה ריקה';
      ol.appendChild(empty);
    }
  };

  const addWrap = document.createElement('div');
  addWrap.className = 'category-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'category-input';
  input.placeholder = 'הוסף מקור תקציב';
  const addBtn = miniBtn('+ הוסף', () => {
    const value = input.value.trim();
    if (!value) return;
    if (!list.some((s) => s.toLowerCase() === value.toLowerCase())) list.push(value);
    input.value = '';
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });
  const context = { budgetLabel, city };
  const excelValue = `${budgetLabel}::${city}`;
  const saveBtn = miniBtn('שמור', async () => {
    if (list.length) {
      await saveMapping(MAP_TYPES.budgetSource, excelValue, list[0], context, { siteValues: [...list] });
      status.textContent = '✓ נשמר';
    } else {
      // Empty list => this combo is unconfigured; remove any stored mapping.
      await deleteMapping(MAP_TYPES.budgetSource, excelValue, context);
      status.textContent = 'נמחק';
    }
  });
  saveBtn.classList.add('primary');
  addWrap.append(input, addBtn, saveBtn, status);

  block.append(heading, ol, addWrap);
  renderList();
  return block;
}

/** Pre-lists every (city × budget label) combo with its ordered source-list editor,
 * grouped by city and prefilled from the stored config. This is the sole place budget
 * sources are configured now that upload no longer prompts for them. */
async function renderBudgetSourceLists() {
  const container = document.getElementById('budgetSourceListsContainer');
  if (!container) return;
  container.innerHTML = '';

  const cities = Object.keys(settings.cities || {});
  const labels = Object.values(BUDGET_LABELS);
  if (!cities.length) {
    container.innerHTML = '<p class="hint">הוסף ערים בראש העמוד כדי להגדיר מקורות תקציב.</p>';
    return;
  }

  for (const city of cities) {
    const group = document.createElement('div');
    group.className = 'bs-city-group';
    const cityHeading = document.createElement('h3');
    cityHeading.textContent = city;
    group.appendChild(cityHeading);
    for (const label of labels) {
      const list = await getBudgetSourceList(label, city);
      group.appendChild(createBudgetSourceListBlock(label, city, list));
    }
    container.appendChild(group);
  }
}

async function renderBudgetBalances() {
  const container = document.getElementById('budgetBalancesContainer');
  if (!container) return;
  container.innerHTML = '';
  const balances = await getBudgetSourceRemaining();
  const entries = Object.entries(balances);
  if (!entries.length) {
    container.innerHTML =
      '<p class="hint">אין יתרות שמורות. קרא אותן מדף הבית בכפתור "קרא יתרות מקורות" שבפופאפ.</p>';
    return;
  }
  for (const [name, amount] of entries) {
    const row = document.createElement('div');
    row.className = 'balance-row';
    const label = document.createElement('span');
    label.className = 'balance-name';
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'balance-input';
    input.value = amount;
    input.addEventListener('change', async () => {
      const all = await getBudgetSourceRemaining();
      all[name] = Number(input.value) || 0;
      await saveBudgetSourceRemaining(all);
    });
    const rm = miniBtn('✕', async () => {
      const all = await getBudgetSourceRemaining();
      delete all[name];
      await saveBudgetSourceRemaining(all);
      await renderBudgetBalances();
    });
    row.append(label, input, rm);
    container.appendChild(row);
  }
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
  // budgetSource is a priority *list* - edited only in its dedicated editor above, so it's
  // excluded here (a single-value save from this table would drop the extra sources).
  const rows = (await listMappingsFlat()).filter((r) => r.type !== MAP_TYPES.budgetSource);
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
  settings.pageWaitMs = Number(document.getElementById('pageWaitMs').value) || 20000;
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
      pageWaitMs: settings.pageWaitMs,
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
    if (data.pageWaitMs !== undefined) settings.pageWaitMs = data.pageWaitMs;

    // Mappings, categories, and captured item info (chrome.storage.local).
    await importMappingData(data);

    renderCities();
    await renderCategories();
    await renderMappings();
    document.getElementById('siteUrl').value = settings.siteUrl || '';
    document.getElementById('fillDelayMs').value = settings.fillDelayMs || 400;
    document.getElementById('idLookupWaitMs').value = settings.idLookupWaitMs || 2000;
    document.getElementById('searchWaitMs').value = settings.searchWaitMs || 1500;
    document.getElementById('pageWaitMs').value = settings.pageWaitMs || 20000;

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
