/** FormTitan content script – field filling & navigation */

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFormTitan() {
  return location.hostname.includes('formtitan.com');
}

function getAccessibleDocuments(rootDoc = document) {
  const docs = [];
  const seen = new Set();
  const queue = [rootDoc];
  while (queue.length) {
    const doc = queue.shift();
    if (!doc || seen.has(doc)) continue;
    seen.add(doc);
    docs.push(doc);
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument) queue.push(iframe.contentDocument);
      } catch (e) {}
    }
  }
  return docs;
}

function walkShadowTree(node, visit) {
  if (!node) return null;
  const hit = visit(node);
  if (hit) return hit;
  if (node.shadowRoot) {
    for (const el of node.shadowRoot.querySelectorAll('*')) {
      const found = walkShadowTree(el, visit);
      if (found) return found;
    }
  }
  for (const child of node.children || []) {
    const found = walkShadowTree(child, visit);
    if (found) return found;
  }
  return null;
}

function querySelectorDeep(selector) {
  if (!selector) return null;
  for (const doc of getAccessibleDocuments()) {
    try {
      const el = doc.querySelector(selector);
      if (el) return el;
    } catch (e) {}
  }
  return null;
}

function querySelectorAllDeep(selector) {
  const out = [];
  for (const doc of getAccessibleDocuments()) {
    try {
      out.push(...doc.querySelectorAll(selector));
    } catch (e) {}
  }
  return out;
}

function hasElementById(id) {
  for (const doc of getAccessibleDocuments()) {
    try {
      if (doc.getElementById(id)) return true;
    } catch (e) {}
  }
  return false;
}

/** FormTitan uses ids like e199 – getElementById is more reliable than #e199 */
function byId(id) {
  for (const doc of getAccessibleDocuments()) {
    try {
      const el = doc.getElementById(id);
      if (el) return el;
    } catch (e) {}
    try {
      const inShadow = walkShadowTree(doc.documentElement, (node) =>
        node.id === id ? node : null
      );
      if (inShadow) return inShadow;
    } catch (e) {}
  }
  return null;
}

function selectorToElement(selector) {
  if (!selector) return null;
  const m = String(selector).trim().match(/^#?(e\d+|controle\d+)$/i);
  if (m) {
    const el = byId(m[1]);
    if (el) return el;
  }
  return querySelectorDeep(selector);
}

function getPageType() {
  const url = location.href.toUpperCase();
  if (url.includes('/MUTAV') || hasElementById('e199')) return 'mutav';
  if (url.includes('/CATALOG') || hasElementById('e687')) return 'catalog';
  if (url.includes('/WHOHOWM') || hasElementById('e305')) return 'whohowm';
  if (url.includes('IFCJAIDHOME') || hasElementById('e25')) return 'home';
  return 'unknown';
}

function setNativeValue(element, value) {
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
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function selectOptionByText(selectEl, text) {
  const target = normalizeText(text).toLowerCase();
  const options = [...selectEl.options];
  let match = options.find((o) => normalizeText(o.text).toLowerCase() === target);
  if (!match) {
    match = options.find((o) => {
      const opt = normalizeText(o.text).toLowerCase();
      return opt.includes(target) || target.includes(opt);
    });
  }
  if (match) {
    selectEl.value = match.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function querySelector(selector) {
  return selectorToElement(selector);
}

async function waitForElement(selector, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (querySelector(selector)) return true;
    await sleep(250);
  }
  return false;
}

function isEditable(el) {
  if (!el) return false;
  if (el.readOnly || el.disabled) return false;
  if (el.getAttribute('aria-readonly') === 'true') return false;
  return true;
}

function findMuiFieldInput(selector) {
  const m = String(selector || '').trim().match(/^#?e(\d+)$/i);
  if (m) {
    const input = byId(`controle${m[1]}`) || querySelectorDeep(`#controle${m[1]}`);
    if (input) {
      const root = querySelector(selector) || input.closest(`#e${m[1]}`) || input.parentElement;
      return { root, input };
    }
  }
  const root = querySelector(selector);
  if (!root) return null;
  const input =
    root.matches('input, textarea') ? root : root.querySelector('input:not([type="hidden"]), textarea');
  return input ? { root, input } : null;
}

function readFieldValue(selector) {
  const parts = findMuiFieldInput(selector);
  if (parts?.input) return String(parts.input.value ?? '').trim();
  const el = querySelector(selector);
  if (!el) return '';
  const input =
    el.matches('input, textarea, select') ? el : el.querySelector('input, textarea, select');
  return String(input?.value ?? el.value ?? el.textContent ?? '').trim();
}

async function fillFieldWithRetry(selector, value, timeoutMs = 15000) {
  const expected = String(value ?? '').trim();
  if (!expected) return { field: selector, ok: false, reason: 'empty value' };

  const start = Date.now();
  let last = { field: selector, ok: false, reason: 'element not found' };
  while (Date.now() - start < timeoutMs) {
    last = await fillField(selector, value);
    const actual = readFieldValue(selector);
    if (actual === expected || actual.replace(/\D/g, '') === expected.replace(/\D/g, '')) {
      return { ...last, ok: true, field: selector, value: actual, verified: true };
    }
    await sleep(250);
  }
  return { ...last, ok: false, reason: last.reason || 'value not confirmed in field' };
}

async function fillField(selector, value, isSelect = false) {
  const el = querySelector(selector);
  if (!el) return { field: selector, ok: false, reason: 'element not found' };
  if (value === undefined || value === null || value === '') {
    return { field: selector, ok: false, reason: 'empty value' };
  }

  const input = el.matches('input, textarea, select') ? el : el.querySelector('input, textarea, select');

  if (input?.tagName === 'SELECT' || isSelect) {
    const selectEl = input?.tagName === 'SELECT' ? input : el.querySelector('select') || el;
    const ok = await fillFormTitanDropdown(selector, [String(value)]);
    return { field: selector, ok, value: String(value), label: selector };
  }

  const target = input || el;
  setNativeValue(target, String(value));
  return { field: selector, ok: true, value: String(value), label: selector };
}

async function fillFieldIfEditable(selector, value, label, optional = false) {
  const el = querySelector(selector);
  const input = el?.matches('input, textarea') ? el : el?.querySelector('input, textarea');
  const target = input || el;
  if (!target) return { field: selector, ok: false, reason: 'element not found', label };
  // An empty value in an optional field (e.g. בית) is not a failure - just skip it.
  if (optional && (value === undefined || value === null || String(value).trim() === '')) {
    return { field: selector, ok: true, skipped: true, reason: 'empty (optional)', value: '', label };
  }
  if (!isEditable(target)) {
    const current = target.value || target.textContent || '';
    return { field: selector, ok: true, skipped: true, reason: 'readonly', value: current.trim(), label };
  }
  return { ...await fillField(selector, value), label: label || selector };
}

async function clickButton(selector) {
  const el = querySelector(selector);
  if (!el) return false;
  const clickable =
    el.matches('button, a, input[type="button"], input[type="submit"]') ?
      el
    : el.querySelector('button, a, [role="button"], input[type="button"]') || el;
  clickable.focus?.();
  clickable.click();
  clickable.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

async function waitForLookupComplete(lastNameSelector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = querySelector(lastNameSelector);
    const input = el?.matches('input, textarea') ? el : el?.querySelector('input, textarea');
    if (input?.value?.trim()) return true;
    if (input && isEditable(input)) return true;
    await sleep(300);
  }
  return false;
}

function normalizeMatchText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)\s*/g, ') ');
}

function textMatchesOption(actual, expected) {
  const a = normalizeMatchText(actual);
  const e = normalizeMatchText(expected);
  if (!a || !e) return false;
  if (a === e) return true;
  if (a.includes(e) || e.includes(a)) return true;
  // allow partial match on first significant word chunk
  const aWords = a.split(' ').filter((w) => w.length > 2);
  const eWords = e.split(' ').filter((w) => w.length > 2);
  if (aWords.length && eWords.length && aWords[0] === eWords[0]) {
    const overlap = eWords.filter((w) => aWords.includes(w)).length;
    if (overlap >= Math.min(2, eWords.length)) return true;
  }
  return false;
}

/** Checks actual CSS visibility, not just layout dimensions - an element (or an
 * ancestor) hidden via display:none/visibility:hidden/opacity:0 can still report a
 * non-zero getBoundingClientRect() (e.g. visibility:hidden keeps its layout box),
 * which previously made a catalog item pre-rendered-but-hidden-pending-budget-
 * selection look "visible" and falsely counted as already selected/clickable. */
function isVisible(el) {
  if (!el?.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const view = el.ownerDocument?.defaultView;
  if (!view) return true;
  for (let node = el; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (!style) break;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
  }
  return true;
}

/** Manual clicks work on this site but our synthetic ones often haven't. Two
 * things a real click has that a naive dispatch lacks and that a drag/drop-capable
 * UI like FormTitan is sensitive to:
 *   1. Pointer Events (pointerdown/pointerup) - modern MUI/ripple components and
 *      DnD libraries listen for these, not classic mouse events.
 *   2. Real coordinates - events default to clientX/clientY 0,0; a drag-vs-click
 *      detector comparing down/up positions (or ignoring events "off" the element)
 *      can treat a (0,0) press as a drag or noise instead of a click.
 * So fire the full realistic pointer+mouse sequence, at the element's center, with
 * correct button/buttons state. Dispatched on the element itself (bubbling reaches
 * delegated React/MUI handlers) - not on elementFromPoint's result, which was a
 * wrong guess that also broke lookup-dialog clicks elsewhere. */
function dispatchClick(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: el.ownerDocument?.defaultView || window, clientX: cx, clientY: cy, button: 0 };
  const down = { ...base, buttons: 1 };
  const up = { ...base, buttons: 0 };
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
  const hasPointer = typeof PointerEvent !== 'undefined';

  if (hasPointer) el.dispatchEvent(new PointerEvent('pointerover', { ...base, ...pointer }));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  if (hasPointer) el.dispatchEvent(new PointerEvent('pointerdown', { ...down, ...pointer }));
  el.dispatchEvent(new MouseEvent('mousedown', down));
  el.focus?.();
  if (hasPointer) el.dispatchEvent(new PointerEvent('pointerup', { ...up, ...pointer }));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  el.dispatchEvent(new MouseEvent('click', up));
}

/** new KeyboardEvent(...) can't set keyCode/which through its init dict (they're
 * not part of the standard KeyboardEventInit, so they silently stay 0) - a lot of
 * MUI-generation code still checks e.keyCode/e.which (e.g. === 13 for Enter)
 * instead of e.key, so a plain dispatch can go completely unnoticed. */
function dispatchKey(el, key, keyCode) {
  if (!el) return;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { get: () => keyCode });
    Object.defineProperty(event, 'which', { get: () => keyCode });
    el.dispatchEvent(event);
  }
}

function collectOptionElements(withinRoot = null) {
  const selectors = [
    '[role="option"]',
    '[role="listbox"] *',
    '.k-list-item',
    '.k-item',
    '.k-list .k-item',
    '.dropdown-item',
    '.ft-list-item',
    '.select2-results__option',
    '.ui-menu-item',
    'li',
    'label',
    'span',
    'div',
  ];
  const seen = new Set();
  const out = [];

  function add(el) {
    if (!el || seen.has(el) || !isVisible(el)) return;
    const t = normalizeText(el.textContent);
    if (!t || t.length > 150) return;
    seen.add(el);
    out.push(el);
  }

  if (withinRoot) {
    for (const sel of selectors) {
      try {
        withinRoot.querySelectorAll(sel).forEach(add);
      } catch (e) {}
    }
    return out;
  }

  for (const sel of selectors) {
    for (const el of querySelectorAllDeep(sel)) add(el);
  }
  for (const doc of getAccessibleDocuments()) {
    try {
      walkShadowForOptions(doc.documentElement, add);
    } catch (e) {}
  }
  return out;
}

function walkShadowForOptions(node, add) {
  if (!node || node.nodeType !== 1) return;
  const tag = node.tagName?.toLowerCase();
  if (
    ['li', 'label', 'span', 'div', 'button', 'option'].includes(tag) ||
    node.getAttribute('role') === 'option'
  ) {
    add(node);
  }
  if (node.shadowRoot) {
    for (const el of node.shadowRoot.querySelectorAll('*')) walkShadowForOptions(el, add);
  }
  for (const child of node.children || []) walkShadowForOptions(child, add);
}

function dropdownPreferredTexts(value) {
  const v = normalizeText(value);
  const variants = [
    v,
    v.replace(/\s{2,}/g, ' '),
    v.replace(/\s+\(/g, ' ('),
    v.replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')'),
  ];
  return [...new Set(variants.filter(Boolean))];
}

/** Sets the value via the native setter only - no events. Used while simulating
 * per-character typing (typeIntoMuiInput below), where setNativeValue's own
 * input+change+blur firing on every keystroke (a fake "blur" per character, which
 * a real user never does) can make a React-controlled field discard the typed
 * value instead of ever registering it. */
function setValueQuietly(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

/** Types `text` into a React/MUI-controlled input.
 *  - `instant: true` sets the whole value at once (paste-like, one input event) -
 *    fine for boxes that filter only on an explicit submit (item search, lookup
 *    modal), and much faster.
 *  - default is per-keystroke (one input event per char) - safest for components
 *    that filter live as you type (the autocomplete dropdowns), which can miss a
 *    bulk-set value. */
async function typeIntoMuiInput(input, text, instant = false) {
  setValueQuietly(input, '');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  await sleep(instant ? 20 : 80);
  if (instant) {
    setValueQuietly(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertFromPaste' }));
  } else {
    let built = '';
    for (const ch of text) {
      built += ch;
      setValueQuietly(input, built);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(35);
    }
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findMatchingOption(elements, preferredTexts) {
  for (const el of elements) {
    const t = el.textContent || el.value || '';
    for (const pref of preferredTexts) {
      if (textMatchesOption(t, pref)) return el;
    }
  }
  return null;
}

function clickMatchingOption(elements, preferredTexts) {
  const el = findMatchingOption(elements, preferredTexts);
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch (e) {}
  dispatchClick(el);
  return true;
}

function tryNativeSelect(root, preferredTexts) {
  const select = root.tagName === 'SELECT' ? root : root.querySelector('select');
  if (!select) return false;
  for (const opt of select.options) {
    for (const pref of preferredTexts) {
      if (textMatchesOption(opt.text, pref) || textMatchesOption(opt.value, pref)) {
        select.value = opt.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
  }
  return false;
}

function tryRadioOrLabel(root, preferredTexts) {
  for (const input of root.querySelectorAll('input[type="radio"]')) {
    const label =
      (input.id && root.querySelector(`label[for="${input.id}"]`)) ||
      input.closest('label') ||
      input.parentElement?.querySelector('label');
    const candidates = [input.value, label?.textContent, input.getAttribute('aria-label')];
    for (const c of candidates) {
      for (const pref of preferredTexts) {
        if (textMatchesOption(c, pref)) {
          dispatchClick(label || input);
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
  }

  for (const label of root.querySelectorAll('label, span, button')) {
    if (!isVisible(label)) continue;
    for (const pref of preferredTexts) {
      if (textMatchesOption(label.textContent, pref)) {
        dispatchClick(label);
        return true;
      }
    }
  }
  return false;
}

function findMuiAutocompleteParts(selector) {
  const m = String(selector || '').trim().match(/^#?e(\d+)$/i);
  if (m) {
    const byDataId = querySelectorDeep(`[data-id="dropdown-e${m[1]}"]`);
    if (byDataId) {
      const input = byDataId.querySelector(
        `input#controle${m[1]}, input.MuiAutocomplete-input, input[aria-autocomplete="list"]`
      );
      if (input) {
        return {
          autocomplete: byDataId,
          input,
          combobox: byDataId.matches('[role="combobox"]') ? byDataId : byDataId,
        };
      }
    }
  }

  const hit = querySelector(selector);
  if (!hit) return null;

  const autocomplete =
    hit.closest('.MuiAutocomplete-root') ||
    hit.querySelector('.MuiAutocomplete-root') ||
    (hit.getAttribute('role') === 'combobox' ? hit : null);
  if (!autocomplete) return null;

  const input = autocomplete.querySelector(
    'input.MuiAutocomplete-input, input[aria-autocomplete="list"]'
  );
  if (!input) return null;

  const combobox =
    autocomplete.matches('[role="combobox"]') ?
      autocomplete
    : autocomplete.querySelector('[role="combobox"]') || autocomplete;

  return { autocomplete, input, combobox };
}

function findMuiListbox(combobox, input) {
  const popupId = combobox?.getAttribute('aria-owns') || input?.getAttribute('aria-controls');
  if (popupId) {
    const popup = byId(popupId);
    if (popup) {
      return popup.getAttribute('role') === 'listbox' ?
          popup
        : popup.querySelector('[role="listbox"]') || popup;
    }
  }

  for (const popper of querySelectorAllDeep('.MuiAutocomplete-popper')) {
    if (!isVisible(popper)) continue;
    const listbox = popper.querySelector('[role="listbox"]');
    if (listbox) return listbox;
    if (popper.querySelector('[role="option"]')) return popper;
  }

  for (const el of querySelectorAllDeep('[role="listbox"]')) {
    if (isVisible(el)) return el;
  }
  return null;
}

async function openMuiAutocomplete(autocomplete, input, combobox) {
  dispatchClick(input);
  input.focus();
  await sleep(200);

  if (combobox.getAttribute('aria-expanded') !== 'true') {
    const popupBtn = autocomplete.querySelector('.MuiAutocomplete-popupIndicator');
    if (popupBtn) dispatchClick(popupBtn);
    await sleep(350);
  }
}

async function pickFromMuiList(listbox, preferredTexts, input) {
  if (!listbox) return false;
  const options = listbox.querySelectorAll('[role="option"]');
  if (clickMatchingOption([...options], preferredTexts)) {
    await sleep(250);
    return preferredTexts.some((pref) => textMatchesOption(input.value, pref));
  }
  return false;
}

async function fillMuiAutocomplete(selector, preferredTexts) {
  const parts = findMuiAutocompleteParts(selector);
  if (!parts) return false;

  const { autocomplete, input, combobox } = parts;

  for (const pref of preferredTexts) {
    if (textMatchesOption(input.value, pref)) return true;

    const clearBtn = autocomplete.querySelector('.MuiAutocomplete-clearIndicator');
    if (clearBtn && input.value && !textMatchesOption(input.value, pref)) {
      dispatchClick(clearBtn);
      await sleep(200);
    }

    // Strategy 1: open list and click option directly (works for סיווג משפחה etc.)
    await openMuiAutocomplete(autocomplete, input, combobox);
    let listbox = findMuiListbox(combobox, input);
    if (await pickFromMuiList(listbox, [pref], input)) return true;

    // Strategy 2: type to filter, then click option
    await openMuiAutocomplete(autocomplete, input, combobox);
    await typeIntoMuiInput(input, pref);
    await sleep(450);
    listbox = findMuiListbox(combobox, input);
    if (await pickFromMuiList(listbox, [pref], input)) return true;

    if (clickMatchingOption(collectOptionElements(), [pref])) {
      await sleep(250);
      if (textMatchesOption(input.value, pref)) return true;
    }

    // Strategy 3: keyboard select first filtered option
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(120);
    dispatchKey(input, 'Enter', 13);
    await sleep(250);
    if (textMatchesOption(input.value, pref)) return true;
  }

  return false;
}

async function fillFormTitanDropdown(selector, preferredTexts) {
  const root = querySelector(selector);
  if (!root) return false;

  if (findMuiAutocompleteParts(selector)) {
    if (await fillMuiAutocomplete(selector, preferredTexts)) return true;
  }

  if (tryNativeSelect(root, preferredTexts)) return true;
  if (tryRadioOrLabel(root, preferredTexts)) return true;
  if (clickMatchingOption(collectOptionElements(root), preferredTexts)) return true;

  const openers = [
    root.querySelector('[role="combobox"]'),
    root.querySelector('.k-select'),
    root.querySelector('.k-dropdown-wrap'),
    root.querySelector('[class*="dropdown"]'),
    root.querySelector('[class*="select"]'),
    root.querySelector('.ft-combobox'),
    root.querySelector('input'),
    root.querySelector('span'),
    root,
  ].filter(Boolean);

  for (const opener of openers) {
    dispatchClick(opener);
    opener.focus?.();
    await sleep(500);

    const input = root.querySelector('input:not([type="hidden"])');
    if (input) {
      setNativeValue(input, preferredTexts[0]);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(400);
    }

    if (clickMatchingOption(collectOptionElements(), preferredTexts)) return true;
    if (clickMatchingOption(collectOptionElements(root), preferredTexts)) return true;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
  }

  return false;
}

function isMuiLookupField(selector) {
  const parts = findMuiFieldInput(selector);
  if (!parts?.root) return false;
  const root =
    parts.root.closest('.ft--theme--FormField--lookup') ||
    parts.root.querySelector('.ft--theme--FormField--lookup') ||
    (parts.root.classList?.contains('ft--theme--FormField--lookup') ? parts.root : null);
  return Boolean(
    root ||
    parts.root.querySelector(
      'button[aria-label*="lookup"], button[aria-label*="Lookup"], button[aria-label*="חיפוש"]'
    )
  );
}

function isMuiDateField(selector) {
  const parts = findMuiFieldInput(selector);
  if (!parts?.root) return false;
  return Boolean(
    parts.root.closest('.ft--theme--FormField--date') ||
    parts.root.classList?.contains('ft--theme--FormField--date') ||
    parts.root.querySelector('.ft--theme--FormField--date')
  );
}

async function fillMuiDateField(selector, value, label) {
  const parts = findMuiFieldInput(selector);
  if (!parts) return { field: selector, ok: false, reason: 'element not found', label };

  const { input } = parts;
  if (!isEditable(input)) {
    const current = input.value?.trim() || '';
    return { field: selector, ok: true, skipped: true, reason: 'readonly', value: current, label };
  }

  const dateStr = normalizeBirthDate(value);
  if (!dateStr) return { field: selector, ok: false, reason: 'empty value', label };

  dispatchClick(input);
  input.focus();
  await sleep(150);
  input.select?.();
  await typeIntoMuiInput(input, dateStr);
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  await sleep(250);

  const actual = readFieldValue(selector);
  const ok =
    actual === dateStr ||
    actual.replace(/\D/g, '') === dateStr.replace(/\D/g, '') ||
    textMatchesOption(actual, dateStr);
  return { field: selector, ok, value: actual || dateStr, label };
}

function fieldIdFromSelector(selector) {
  const m = String(selector || '').match(/^#?e(\d+)$/i);
  return m ? m[1] : null;
}

function normalizeBirthDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';

  const parts = s.split(/[./-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return s;

  let dayNum = parseInt(parts[0], 10);
  let monthNum = parseInt(parts[1], 10);
  let yearNum = parseInt(parts[2], 10);
  if (Number.isNaN(dayNum) || Number.isNaN(monthNum) || Number.isNaN(yearNum)) return s;

  // Israeli dd/mm/yyyy - swap an impossible month (American mm/dd) like 02/16 -> 16/02.
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

function findLookupDialog(fieldId) {
  const tries = [
    fieldId ? `.ft--e${fieldId}--modal` : null,
    fieldId ? `.lookup-dialog-wrap` : null,
    '[role="dialog"].lookup-dialog-wrap',
    '[role="dialog"]',
  ].filter(Boolean);

  for (const sel of tries) {
    for (const el of querySelectorAllDeep(sel)) {
      if (!isVisible(el)) continue;
      const dialog = el.matches('[role="dialog"]') ? el : el.closest('[role="dialog"]');
      if (dialog?.querySelector('.MuiTableBody-root, tbody')) return dialog;
    }
  }
  return null;
}

function clickDialogButton(dialog, textFragments) {
  for (const btn of dialog.querySelectorAll('button')) {
    const t = normalizeText(btn.textContent);
    if (textFragments.every((frag) => t.includes(frag))) {
      dispatchClick(btn);
      return true;
    }
  }
  return false;
}

/** The lookup modal's search button is `<button class="...modal--search">חיפוש</button>`
 * - text is just "חיפוש" (not "לחצו לחיפוש"), so match it by its stable class first,
 * then fall back to the bare word. */
function clickModalSearchButton(dialog) {
  const btn = dialog.querySelector('button[class*="modal--search"], button[class*="lookupModal--search"]');
  if (btn) {
    dispatchClick(btn);
    return true;
  }
  return clickDialogButton(dialog, ['חיפוש']);
}

async function fillMuiLookupField(selector, searchText, waitMs = 2000) {
  const parts = findMuiFieldInput(selector);
  if (!parts) return { ok: false, reason: 'element not found' };

  const { root, input } = parts;
  const fieldId = fieldIdFromSelector(selector);
  const target = normalizeMatchText(searchText);
  if (!target) return { ok: false, reason: 'empty search text' };

  if (textMatchesOption(input.value, searchText)) {
    return { ok: true, value: input.value.trim(), matched: 'already set' };
  }

  const lookupBtn = root.querySelector(
    'button[aria-label*="lookup"], button[aria-label*="Lookup"], button[aria-label*="חיפוש"]'
  );
  if (!lookupBtn) return { ok: false, reason: 'lookup button not found' };

  dispatchClick(lookupBtn);
  await sleep(600);

  let dialog = null;
  for (let i = 0; i < 15; i++) {
    dialog = findLookupDialog(fieldId);
    if (dialog) break;
    await sleep(200);
  }
  if (!dialog) return { ok: false, reason: 'lookup dialog not opened' };

  const modalInput = dialog.querySelector(
    'input[aria-label="search"], .ft--theme--lookupModal--fieldInput input, input[placeholder="חיפוש"], input[placeholder="Search"]'
  );
  if (modalInput) {
    dispatchClick(modalInput);
    modalInput.focus();
    await typeIntoMuiInput(modalInput, searchText, true);
    await sleep(300);
    // Same submit-trigger set that fixed the catalog item search box: some builds
    // filter on Enter, others need the search button clicked.
    dispatchKey(modalInput, 'Enter', 13);
    await sleep(150);
  }

  clickModalSearchButton(dialog);
  await sleep(waitMs);

  const rows = dialog.querySelectorAll('.MuiTableBody-root .MuiTableRow-root, tbody tr');
  let matchedRow = null;
  for (const row of rows) {
    const textCells = [...row.querySelectorAll('td')].map((td) => normalizeMatchText(td.textContent));
    const rowLabel = textCells.find((t) => t.length > 1 && t.length < 120) || '';
    if (
      rowLabel &&
      (textMatchesOption(rowLabel, searchText) ||
        rowLabel.includes(target) ||
        target.includes(rowLabel))
    ) {
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) {
    return { ok: false, reason: 'no matching row in lookup table' };
  }

  const radio =
    matchedRow.querySelector('input[type="radio"]') ||
    matchedRow.querySelector('.MuiRadio-root, .ft--e229--modal--checkbox, [class*="modal--checkbox"]');
  if (radio) {
    dispatchClick(radio);
  } else {
    dispatchClick(matchedRow);
  }
  await sleep(300);

  const saved = clickDialogButton(dialog, ['שמירת', 'בחירה']);
  if (!saved) clickDialogButton(dialog, ['שמירה']);
  await sleep(500);

  const actual = readFieldValue(selector);
  if (actual && (textMatchesOption(actual, searchText) || normalizeMatchText(actual).includes(target))) {
    return { ok: true, value: actual, matched: searchText };
  }

  return { ok: saved, value: actual || searchText, matched: saved ? searchText : 'row selected' };
}

async function fillSearchField(selector, searchText, waitMs = 1500) {
  if (isMuiLookupField(selector)) {
    return fillMuiLookupField(selector, searchText, waitMs);
  }

  const parts = findMuiFieldInput(selector);
  const el = parts?.root || querySelector(selector);
  if (!el) return { ok: false, reason: 'element not found' };

  const input = parts?.input || (el.matches('input') ? el : el.querySelector('input') || el);
  setNativeValue(input, searchText);
  await sleep(waitMs);

  const target = normalizeText(searchText).toLowerCase();
  const inputDoc = input.ownerDocument || document;
  const candidates = [
    ...inputDoc.querySelectorAll(
      '[role="option"], .k-list-item, .k-item, li, .dropdown-item, .autocomplete-item, .ui-menu-item'
    ),
    ...querySelectorAllDeep(
      '[role="option"], .k-list-item, .k-item, li, .dropdown-item, .autocomplete-item, .ui-menu-item'
    ),
  ];
  const seen = new Set();
  for (const opt of candidates) {
    if (seen.has(opt)) continue;
    seen.add(opt);
    const t = normalizeText(opt.textContent).toLowerCase();
    if (t.includes(target) || target.includes(t)) {
      opt.click();
      await sleep(300);
      return { ok: true, value: searchText, matched: opt.textContent.trim() };
    }
  }

  dispatchKey(input, 'Enter', 13);
  await sleep(300);
  return { ok: true, value: searchText, matched: 'typed+enter' };
}

function buildStepResult(step, stepName, results, extra = {}) {
  return {
    step,
    stepName,
    results,
    filled: results.filter((r) => r.ok && !r.skipped).length,
    total: results.length,
    formTitan: true,
    ...extra,
  };
}

async function fillMutavIdLookup(fields, selectors, delayMs, idLookupWaitMs) {
  const s = selectors.step1 || {};
  const results = [];

  const idFill = await fillFieldWithRetry(s.idNumber, fields.idNumber, 15000);
  results.push({ ...idFill, field: 'idNumber', label: 'ת.ז.' });
  if (!idFill.ok) return buildStepResult(1, 'MUTAV', results, { phase: 'id' });

  await sleep(delayMs);

  const lookupOk = await clickButton(s.idLookupButton);
  results.push({ field: 'idLookup', ok: lookupOk, label: 'חיפוש ת.ז.', value: fields.idNumber });
  if (!lookupOk) return buildStepResult(1, 'MUTAV', results, { phase: 'id' });

  const lookupReady = await waitForLookupComplete(s.lastName, idLookupWaitMs);
  results.push({
    field: 'idLookupWait',
    ok: lookupReady,
    label: 'המתנה לחיפוש',
    value: lookupReady ? 'ready' : 'timeout',
  });

  return buildStepResult(1, 'MUTAV', results, { phase: 'id' });
}

async function fillMutavDetails(fields, selectors, delayMs) {
  const s = selectors.step1 || {};
  const results = [];

  results.push(await fillFieldIfEditable(s.lastName, fields.lastName, 'שם משפחה'));
  await sleep(delayMs);
  results.push(await fillFieldIfEditable(s.firstName, fields.firstName, 'שם פרטי'));
  await sleep(delayMs);

  const mutavOk = await fillFormTitanDropdown(s.mutavKnowledge, ['כן', 'yes', 'Yes']);
  results.push({ field: 'mutavKnowledge', ok: mutavOk, label: 'מידע עבר עם המוטב', value: 'כן' });
  await sleep(delayMs);

  const dropdownFields = [
    ['gender', fields.gender, 'מגדר'],
    ['sector', fields.sector, 'מגזר'],
    ['ministryFileExists', fields.ministryFileExists, 'קובץ קיים'],
    ['maritalStatus', fields.maritalStatus, 'מצב משפחתי'],
    ['holocaustSurvivor', fields.holocaustSurvivor, 'ניצול שואה'],
    ['birthCountry', fields.birthCountry, 'ארץ לידה'],
    ['familyClassification', fields.familyClassification, 'סיווג משפחה'],
  ];

  for (const [key, val, label] of dropdownFields) {
    if (s[key] && val) {
      const ok = await fillFormTitanDropdown(s[key], dropdownPreferredTexts(val));
      results.push({ field: key, ok, label, value: val });
      await sleep(delayMs);
    }
  }

  if (s.householdSize && fields.householdSize) {
    results.push(await fillField(s.householdSize, fields.householdSize));
    await sleep(delayMs);
  }

  results.push(
    isMuiDateField(s.birthDate) ?
      await fillMuiDateField(s.birthDate, fields.birthDate, 'תאריך לידה')
    : await fillFieldIfEditable(s.birthDate, fields.birthDate, 'תאריך לידה')
  );
  await sleep(delayMs);
  results.push(await fillFieldIfEditable(s.street, fields.street, 'רחוב'));
  await sleep(delayMs);
  results.push(await fillFieldIfEditable(s.building, fields.building, 'בית', true));
  await sleep(delayMs);

  if (s.city && fields.citySearch) {
    const cityRes = await fillSearchField(s.city, fields.citySearch);
    results.push({ field: 'city', ok: cityRes.ok, label: 'עיר', value: fields.citySearch });
    await sleep(delayMs);
  }

  if (fields.needsSettlement && s.settlement && fields.settlement) {
    results.push(await fillField(s.settlement, fields.settlement));
    await sleep(delayMs);
  }

  if (fields.mobilePhone && s.mobilePhone) {
    results.push(await fillField(s.mobilePhone, fields.mobilePhone));
    await sleep(delayMs);
  }
  if (fields.homePhone && s.homePhone) {
    results.push(await fillField(s.homePhone, fields.homePhone));
    await sleep(delayMs);
  }

  return buildStepResult(1, 'MUTAV', results, { phase: 'details' });
}

async function fillMutavPage(fields, selectors, delayMs, idLookupWaitMs) {
  const idPart = await fillMutavIdLookup(fields, selectors, delayMs, idLookupWaitMs);
  const idFailed = idPart.results?.some((r) => r.field === 'idNumber' && !r.ok);
  const lookupFailed = idPart.results?.some((r) => r.field === 'idLookup' && !r.ok);
  if (idFailed || lookupFailed) return idPart;

  const detailsPart = await fillMutavDetails(fields, selectors, delayMs);
  return {
    ...detailsPart,
    results: [...(idPart.results || []), ...(detailsPart.results || [])],
    filled: (idPart.filled || 0) + (detailsPart.filled || 0),
    total: (idPart.total || 0) + (detailsPart.total || 0),
  };
}

/** Clicking an item always navigates straight to WhoHowM (see docs/PIPELINE.md), so
 * success must be verified by actually *arriving* there - checking merely that the
 * page "stopped being catalog" is not enough: a transient DOM blip (loading
 * overlay, re-render) can momentarily make getPageType() return 'unknown' even
 * though the page never really left CATALOG, which previously reported a false
 * success and silently stalled the run. */
async function waitForWhoHowMPage(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getPageType() === 'whohowm') return true;
    await sleep(200);
  }
  return false;
}

/** The item's repeater cell (class ft--st-placeholder / repeatPlaceholder /
 * droppable, per docs/PIPELINE.md) is a broader click target than any one
 * component inside it - tried last, since clicking it directly is less precise
 * than the item's own caption text. */
function findRepeaterCell(el) {
  return el?.closest?.('[class*="repeatPlaceholder"], [class*="droppable"], [class*="repeatColPlaceHolder"]') || null;
}

/** Ordered list of plausible click targets inside an item card, most-likely first:
 * the "pointed"/cursor:pointer image wrapper, its <img>, and the card container
 * itself (the `#s287-Col*i0` element). We don't know for certain which one carries
 * FormTitan's navigation handler, so clickCatalogItem tries them in order, each
 * verified by an actual page transition. Each carries a short id/class label so a
 * failing run's log says exactly what was clicked. */
function itemClickCandidates(card) {
  if (!card) return [];
  const out = [];
  const seen = new Set();
  const add = (name, el) => {
    if (!el || seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const id = el.id ? `#${el.id}` : `.${(el.className || '').toString().split(/\s+/)[0] || el.tagName.toLowerCase()}`;
    out.push({ label: `${name}${id}`, el });
  };
  add('pointed', card.querySelector('[class~="pointed"]'));
  for (const el of card.querySelectorAll('*')) {
    try {
      if (getComputedStyle(el).cursor === 'pointer') add('cursor', el);
    } catch (e) {}
  }
  add('img', card.querySelector('img'));
  add('card', card);
  return out;
}

/** Finds the CURRENTLY VISIBLE catalog item-search input. Each budget renders its own
 * catalog block with its own search box (different ids per budget - #e421 for one,
 * something else for another), so we match by the item-search placeholder rather than a
 * fixed id, preferring a visible one; the configured selector is only a last fallback. */
function findItemSearchInput(configuredSelector) {
  const byPlaceholder = querySelectorAllDeep(
    'input[placeholder*="משם פריט"], input[placeholder*="שם פריט"]'
  ).filter(isVisible);
  if (byPlaceholder.length) return byPlaceholder[0];
  const bySearchField = querySelectorAllDeep('[class*="FormField--search"] input').filter(isVisible);
  if (bySearchField.length) return bySearchField[0];
  if (configuredSelector) {
    const parts = findMuiFieldInput(configuredSelector);
    if (parts?.input && isVisible(parts.input)) return parts.input;
  }
  return null;
}

/** True if a catalog is currently rendered - either its item-search box or a visible
 * item card (`…-Col*i0`) is present. Both only appear once a budget is selected. */
function isCatalogRendered(configuredSelector) {
  if (findItemSearchInput(configuredSelector)) return true;
  return querySelectorAllDeep('[id*="-Col"][id$="i0"]').some(
    (el) => /-Col\d+i0$/.test(el.id) && isVisible(el)
  );
}

async function waitForCatalogRendered(configuredSelector, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCatalogRendered(configuredSelector)) return true;
    await sleep(200);
  }
  return false;
}

/** Types the item's display text into the visible catalog item-search box, then
 * submits (clicking the search icon), then waits `searchWaitMs` for results. */
async function searchForItem(itemSearchSelector, itemLabel, searchWaitMs) {
  if (!itemLabel) return { ok: false, reason: 'no item label' };
  let input = null;
  const start = Date.now();
  while (Date.now() - start < 4000) {
    input = findItemSearchInput(itemSearchSelector);
    if (input) break;
    await sleep(200);
  }
  if (!input) return { ok: false, reason: 'search box not found' };
  const parts = { input, root: input.closest('[class*="FormField--search"], [class*="FormField-container"]') || input.parentElement };
  dispatchClick(parts.input);
  parts.input.focus();
  await typeIntoMuiInput(parts.input, itemLabel, true);
  await sleep(150);

  // This search box doesn't filter on every keystroke - it needs an explicit
  // trigger. Confirmed: clicking the search icon works, so that's tried first,
  // matching how a real user searches (type, then click search) - the rest are
  // secondary fallbacks in case a future build wires it differently.
  const searchIcon = parts.root?.querySelector('[class*="search-ico"]') || querySelectorDeep('[class*="search-ico"]');
  if (searchIcon) {
    dispatchClick(searchIcon);
    await sleep(150);
    // Some MUI adornments bind the handler on the wrapping button/container
    // rather than the icon itself - click that too, just in case.
    const adornment = searchIcon.closest('[class*="Adornment"], button, [role="button"]');
    if (adornment && adornment !== searchIcon) {
      dispatchClick(adornment);
      await sleep(150);
    }
  }

  // Fallbacks: Enter key with a real keyCode (see dispatchKey - won't trigger a
  // native browser default action like a wrapping <form>'s submit-on-Enter,
  // since that only fires for trusted, real user-generated events), a real
  // .blur() call (onBlur handlers respond the same to a script-triggered blur
  // as a real one, unlike native default actions), and requestSubmit() on an
  // ancestor <form> if there is one (sidesteps the trusted-event limitation
  // above entirely, since it's a direct DOM API call).
  dispatchKey(parts.input, 'Enter', 13);
  await sleep(150);
  parts.input.blur();
  await sleep(150);
  const form = parts.input.closest('form');
  if (form?.requestSubmit) {
    try {
      form.requestSubmit();
    } catch (e) {}
  }

  await sleep(searchWaitMs || 1500);
  return { ok: true };
}

/** After searching, the catalog filters down to a single (or very few) result(s),
 * always at index 0 of some column (`…-Col<n>i0`). Each budget renders its own
 * repeater with its OWN root id (s287, s240, …), and repeaters keep hidden
 * template/duplicate cells, so we look for any `…-Col*i0` cell and return the first
 * VISIBLE one (a synthetic click on a hidden cell silently no-ops). The configured
 * root is only used to prefer among visible matches. */
function findFirstRepeaterResult(repeaterRootId) {
  const all = querySelectorAllDeep('[id*="-Col"][id$="i0"]').filter((el) => /-Col\d+i0$/.test(el.id));
  const visible = all.filter(isVisible);
  if (repeaterRootId) {
    const preferred = visible.find((el) => el.id.startsWith(`${repeaterRootId}-`));
    if (preferred) return preferred;
  }
  return visible[0] || null;
}

/** Every currently-visible item card in the catalog repeater (id like
 * `<root>-Col<n>i<m>`). After a search this is the set of matching items - used to
 * require a unique match before clicking. Scoped to the configured root when it
 * matches, else budget-agnostic. */
function visibleRepeaterItems(repeaterRootId) {
  const all = querySelectorAllDeep('[id*="-Col"]').filter((el) => /-Col\d+i\d+$/.test(el.id));
  const scoped = repeaterRootId ? all.filter((el) => el.id.startsWith(`${repeaterRootId}-`)) : [];
  return (scoped.length ? scoped : all).filter(isVisible);
}

/** True if one of the card's leaf text elements exactly equals the item name (its
 * caption) - distinguishes e.g. "מיטה" from "מיטה אורתופדית" when a search returns both. */
function cardHasExactItem(card, itemLabel) {
  const target = normalizeMatchText(itemLabel);
  for (const el of card.querySelectorAll('*')) {
    if (el.children.length === 0 && normalizeMatchText(el.textContent) === target) return true;
  }
  return false;
}

async function clickCatalogItem(selector, itemLabel, itemSearchSelector, itemRepeaterRoot, searchWaitMs) {
  const attempted = [];

  // Clicks each plausible target inside a card, verifying a page transition after
  // each (short per-candidate wait - navigation is immediate on a real click).
  const tryCard = async (tag, card) => {
    if (!card) return false;
    const candidates = itemClickCandidates(card);
    if (!candidates.length) {
      attempted.push(`${tag}:no-clickable`);
      return false;
    }
    for (const c of candidates) {
      try {
        c.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (e) {}
      dispatchClick(c.el);
      attempted.push(`${tag}:${c.label}`);
      if (await waitForWhoHowMPage(1500)) return true;
    }
    return false;
  };

  const searchResult = await searchForItem(itemSearchSelector, itemLabel, searchWaitMs);
  if (searchResult.ok) {
    // Require a UNIQUE match: after the search there must be exactly one matching item
    // (or, if several substring-matches appear, exactly one whose caption is an exact
    // match). Zero results = search found nothing; many results = the search didn't
    // narrow down / isn't unique - in both cases fail rather than click a guess.
    const results = visibleRepeaterItems(itemRepeaterRoot);
    const exact = results.filter((c) => cardHasExactItem(c, itemLabel));
    let chosen = null;
    if (results.length === 1) chosen = results[0];
    else if (exact.length === 1) chosen = exact[0];

    if (!chosen) {
      return {
        ok: false,
        reason:
          results.length === 0
            ? `החיפוש לא החזיר תוצאות לפריט "${itemLabel}"`
            : `החיפוש החזיר ${results.length} תוצאות ללא התאמה יחידה לפריט "${itemLabel}" – יש לבחור ידנית`,
      };
    }
    if (await tryCard('search', chosen)) return { ok: true };
    // Unique item found but the click didn't navigate - fall through to retry it by
    // text/selector below (same card), rather than failing outright.
  } else if (searchResult.reason !== 'not configured') {
    attempted.push(`search:${searchResult.reason}`);
  }

  // Fallback: match the rendered catalog by display text, resolve to its card.
  const textEl = itemLabel ? findMatchingOption(collectOptionElements(), [itemLabel]) : null;
  if (textEl && (await tryCard('text', findRepeaterCell(textEl) || textEl))) return { ok: true };

  // Last resort: the captured per-render selector (see item-catalog.js).
  const selEl = selector ? querySelector(selector) : null;
  if (selEl && (await tryCard('selector', findRepeaterCell(selEl) || selEl))) return { ok: true };

  return {
    ok: false,
    reason: attempted.length ? `clicked (${attempted.join(', ')}) but page did not advance` : 'item not found',
  };
}

/** Budget names compared without gershayim/quotes - the site shows "שלמ" while our
 * label is 'של"מ'. */
function budgetKey(s) {
  return normalizeText(s).replace(/["'׳״]/g, '');
}

/** Selects a budget in the radiogroup. The clickable control is the MUI radio
 * `<input>` inside each `<label>` (the label text is a sibling span). Matches the
 * label by text (quote-insensitive), falls back to the nth-child index, clicks the
 * radio input, then verifies the catalog's item search box actually appeared - so
 * "budget OK" means the budget really got selected, not just that something was
 * clicked. */
async function selectBudget(group, labelIndex, budgetSiteValue, itemSearchSelector) {
  if (!group) return { ok: false, reason: 'קבוצת התקציב לא נמצאה' };

  // Narrow to the actual radiogroup - the field wrapper (#e687) also holds a caption
  // label whose help text mentions a budget name ("...יש לבחור קטלוג סיוע חירום
  // למשפחות"), which must not be matched.
  const rg =
    group.matches && group.matches('[role="radiogroup"]')
      ? group
      : group.querySelector('[role="radiogroup"]') || group;

  const target = budgetKey(budgetSiteValue);
  // Only real budget options carry a radio input - excludes any caption label.
  const optionLabels = [...rg.querySelectorAll('label')].filter((l) => l.querySelector('input'));

  let label =
    optionLabels.find((l) => budgetKey(l.textContent) === target) ||
    optionLabels.find((l) => {
      const t = budgetKey(l.textContent);
      return t && (t.includes(target) || target.includes(t));
    });
  if (!label && labelIndex) label = optionLabels[labelIndex - 1] || null;
  if (!label) return { ok: false, reason: `התקציב "${budgetSiteValue}" לא נמצא` };

  const input = label.querySelector('input[type="radio"], input');
  const buttonBase = label.querySelector('[class*="ButtonBase"], [class*="MuiRadio-root"]');

  // If it's already the selected catalog, we may already be rendered.
  if (input?.checked && (await waitForCatalogRendered(itemSearchSelector, 1500))) return { ok: true };

  // Try each interactive part in turn - one of them triggers MUI's selection.
  for (const el of [input, buttonBase, label]) {
    if (!el) continue;
    dispatchClick(el);
    if (await waitForCatalogRendered(itemSearchSelector, 2500)) return { ok: true };
  }

  return {
    ok: false,
    reason: `הקטלוג לא נטען אחרי בחירת התקציב (radio checked=${input ? input.checked : '?'})`,
  };
}

async function fillCatalogPage(prepared, selectors, delayMs, searchWaitMs) {
  const s = selectors.step2 || {};
  const results = [];
  // The budget selector group is a role="radiogroup" - fall back to that if the
  // configured id isn't present.
  const group = querySelector(s.budgetGroup) || querySelectorDeep('[role="radiogroup"]');
  const labelIndex = prepared.budgetLabelIndex;
  const itemLabel = prepared.itemSiteValue || prepared.itemSelector;

  const budget = await selectBudget(group, labelIndex, prepared.budgetSiteValue, s.itemSearch);
  results.push({ field: 'budget', label: 'תקציב', value: prepared.budgetSiteValue, ...budget });

  // Don't try to pick an item if the budget didn't actually select - the catalog
  // won't be there.
  if (budget.ok && itemLabel) {
    await sleep(delayMs);
    const itemResult = await clickCatalogItem(
      prepared.itemSelector,
      itemLabel,
      s.itemSearch,
      s.itemRepeaterRoot,
      searchWaitMs
    );
    results.push({ field: 'item', label: 'פריט', value: itemLabel, ...itemResult });
  }

  return buildStepResult(2, 'CATALOG', results);
}

async function fillWhoHowMPage(prepared, selectors, delayMs, searchWaitMs) {
  const s = selectors.step4 || {};
  const results = [];

  if (s.reason && prepared.reason) {
    results.push({ ...(await fillField(s.reason, prepared.reason)), label: 'נימוק' });
    await sleep(delayMs);
  }

  if (s.budgetSource && prepared.budgetSourceSearch) {
    const src = await fillSearchField(s.budgetSource, prepared.budgetSourceSearch, searchWaitMs);
    results.push({ field: 'budgetSource', ok: src.ok, label: 'מקור תקציב', value: prepared.budgetSourceSearch });
    await sleep(delayMs);
  }

  if (s.supplier && prepared.supplier) {
    const sup = await fillSearchField(s.supplier, prepared.supplier, searchWaitMs);
    results.push({ field: 'supplier', ok: sup.ok, label: 'ספק', value: prepared.supplier });
    await sleep(delayMs);
  }

  if (s.amount && prepared.amount) {
    results.push({ ...(await fillField(s.amount, prepared.amount)), label: 'סכום' });
  }

  return buildStepResult(3, 'WhoHowM', results);
}

/** Detects a visible FormTitan error/validation popup, returning its message(s), or
 * null. FormTitan reuses one notification container for validation errors AND transient
 * info/progress toasts ("שומר את הבקשה…", "מחפש עבורך הודעות…"). Both may carry the
 * caution icon (it's in the template), so a real error is identified by a VISIBLE
 * OK/acknowledge button (`sfNotificationMsg--apply` / `btn-yes`) - you acknowledge a
 * validation error, whereas a progress toast has no such button. Generic MUI alert
 * selectors are deliberately NOT used, since FormTitan renders non-errors with them too.
 * (Function-local so re-injecting this content script doesn't hit a top-level
 * "already declared" error.) */
function detectErrorPopup() {
  for (const el of querySelectorAllDeep('[class*="sfNotificationMsg--root"], [class*="warning-ractangle"]')) {
    if (!isVisible(el)) continue;
    const hasOkButton = [...el.querySelectorAll('[class*="sfNotificationMsg--apply"], [class*="btn-yes"]')].some(isVisible);
    if (!hasOkButton) continue; // no acknowledge button => transient toast, not an error
    const paras = [...el.querySelectorAll('p')].map((p) => normalizeText(p.textContent)).filter(Boolean);
    const text = paras.length ? paras.join(' | ') : normalizeText(el.textContent);
    if (text) return text.slice(0, 300);
  }
  return null;
}

async function readBalance(selectors) {
  const sel = selectors.balance?.currentBalance;
  if (!sel) return null;
  const el = querySelector(sel);
  if (!el) return null;
  const text = el.value ?? el.textContent ?? '';
  const num = Number(String(text).replace(/[^\d.-]/g, ''));
  return Number.isNaN(num) ? null : num;
}

/**
 * Reads the home-page "budget sources" PowerTable into { [sourceName]: remainingNIS }, which
 * the upload-time allocator (pipeline.allocateSources) draws down. Names/amounts are taken from
 * the cell's `title` (full, untruncated) with a textContent fallback; amounts like "15,655.00"
 * are parsed to 15655. Only rows currently rendered in the DOM are read (the table virtualizes,
 * but the sources list is short and fully rendered).
 */
async function captureBudgetSourceRemaining(selectors) {
  const cfg = selectors?.budgetSources;
  if (!cfg?.table || !cfg?.row) return { ok: false, reason: 'not-configured', remaining: {} };

  const table = querySelector(cfg.table);
  if (!table) return { ok: false, reason: 'table-not-found', remaining: {} };

  const cellText = (row, sel) => {
    const el = sel ? row.querySelector(sel) : null;
    if (!el) return '';
    const titled = el.matches('[title]') ? el : el.querySelector('[title]');
    return normalizeText(titled?.getAttribute('title') || el.textContent || '');
  };

  const remaining = {};
  let count = 0;
  for (const row of table.querySelectorAll(cfg.row)) {
    const name = cellText(row, cfg.name);
    const num = Number(cellText(row, cfg.remaining).replace(/[^\d.-]/g, ''));
    if (name && !Number.isNaN(num)) {
      remaining[name] = num;
      count += 1;
    }
  }
  return { ok: count > 0, reason: count ? undefined : 'no-rows', remaining, count };
}

async function startNewRecord(selectors) {
  const sel = selectors.navigation?.newRecordButton;
  if (!sel) return { ok: false, error: 'no newRecordButton selector' };
  if (!querySelector(sel)) return { ok: false, error: 'new record button not found' };
  return { ok: await clickButton(sel), action: 'newRecord' };
}

/** One-time click-to-capture: used by options.js to record a real per-item DOM selector,
 * since each catalog item is its own element (see docs/PIPELINE.md). */
function armItemCapture(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener('click', onClick, true);
      clearTimeout(timer);
      resolve(result);
    };
    const onClick = (e) => {
      const el = e.target.closest('[id]') || e.target;
      e.preventDefault();
      e.stopPropagation();
      finish({ ok: true, selector: el.id ? `#${el.id}` : null, text: normalizeText(el.textContent) });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    document.addEventListener('click', onClick, true);
  });
}

async function handleMessage(message) {
  if (message.type === 'PING') {
    return { ok: true, pong: true, page: getPageType(), url: location.href };
  }

  if (message.type === 'VERIFY_ID') {
    const sel = message.selectors?.step1?.idNumber;
    const expected = String(message.idNumber ?? '').trim();
    const actual = readFieldValue(sel);
    const ok =
      actual === expected ||
      actual.replace(/\D/g, '') === expected.replace(/\D/g, '');
    return { ok, actual, expected };
  }

  if (message.type === 'FILL_STEP') {
    const { step, prepared, selectors, delayMs = 400, idLookupWaitMs = 2000, searchWaitMs = 1500 } = message;
    const page = getPageType();
    let outcome;

    if (step === 1 || page === 'mutav') {
      if (!prepared?.fields) {
        return { ok: false, error: 'missing prepared.fields for MUTAV' };
      }
      if (message.phase === 'id') {
        outcome = await fillMutavIdLookup(prepared.fields, selectors, delayMs, idLookupWaitMs);
      } else if (message.phase === 'details') {
        outcome = await fillMutavDetails(prepared.fields, selectors, delayMs);
      } else {
        outcome = await fillMutavPage(prepared.fields, selectors, delayMs, idLookupWaitMs);
      }
    } else if (step === 2 || page === 'catalog') {
      outcome = await fillCatalogPage(prepared, selectors, delayMs, searchWaitMs);
    } else if (step === 3 || page === 'whohowm') {
      outcome = await fillWhoHowMPage(prepared, selectors, delayMs, searchWaitMs);
    } else {
      return { ok: false, error: `wrong page for step ${step}: ${page}` };
    }
    return { ok: true, ...outcome, page: getPageType() };
  }

  if (message.type === 'CLICK_NEXT') {
    const { step, selectors } = message;
    const page = getPageType();
    let selector = '';
    if (page === 'mutav' || step === 1) selector = selectors.step1?.nextButton;
    else if (page === 'whohowm' || step === 3) selector = selectors.step4?.submitButton;
    const clicked = await clickButton(selector);
    return { ok: clicked, page };
  }

  if (message.type === 'START_NEW_RECORD') {
    return startNewRecord(message.selectors);
  }

  if (message.type === 'READ_BALANCE') {
    const balance = await readBalance(message.selectors);
    return { ok: balance !== null, balance };
  }

  if (message.type === 'CAPTURE_SOURCE_REMAINING') {
    return captureBudgetSourceRemaining(message.selectors);
  }

  if (message.type === 'GET_PAGE_INFO') {
    const page = getPageType();
    const hasMutav = hasElementById('e199');
    return {
      ok: true,
      url: location.href,
      page,
      hasMutavForm: hasMutav,
      errorPopup: detectErrorPopup(),
      frameCount: getAccessibleDocuments().length,
      isFormTitan: isFormTitan(),
      isMutavPage: page === 'mutav',
      isCatalogPage: page === 'catalog',
      isWhoHowMPage: page === 'whohowm',
      isHomePage: page === 'home',
    };
  }

  if (message.type === 'CHECK_ERROR_POPUP') {
    return { ok: true, errorPopup: detectErrorPopup() };
  }

  if (message.type === 'ARM_ITEM_CAPTURE') {
    return armItemCapture(message.timeoutMs || 30000);
  }

  return { ok: false, error: `unknown message type: ${message.type}` };
}

if (!globalThis.__ifcjAidMsgListener) {
  globalThis.__ifcjAidMsgListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
}
