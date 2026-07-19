/**
 * Assembles the `state` object for a push/sfmapping call from the values gathered by the read
 * chain plus our pipeline row.
 *
 * FormTitan uses the SAME binding keys on the way in and out, only swapping the separator:
 * a read response returns `view:p43#-#p43:e200` / `param#-#<guid>`, and the push wants
 * `view:p43##p43:e200` / `param##<guid>` with the same value. So most of a push `state` is just
 * the accumulated read values re-emitted with `##`; our row supplies the fields the operator
 * sets and the SF ids thread through as params. See docs/API_PROTOCOL.md.
 */

/** Rewrites a read-response key to its push-state form (`#-#` → `##`). */
export function toStateKey(key) {
  return key.replace(/#-#/g, '##');
}

/**
 * Builds the MUTAV "next" (elemUID=e238) push state.
 *   lookupData - the raw `data` object from the id-lookup (e2847) response.
 *   overrides  - { [stateKey]: value } to set/replace (e.g. the searched id number, the
 *                pipeline-computed family classification, the logged-in account id param).
 * Only the person form fields (`view:p43##p43:*`, minus display-only `:TYPO_TEXT`) and the
 * `param##*` bindings from the lookup carry into the push; `pageParam##*` and other-page fields
 * are dropped. `smartv##id` is always present (empty). Overrides win over lookup values.
 */
export function assembleMutavState(lookupData = {}, overrides = {}) {
  const state = { 'smartv##id': '' };
  for (const [k, v] of Object.entries(lookupData)) {
    const nk = toStateKey(k);
    if (nk.includes(':TYPO_TEXT')) continue;
    if (nk.startsWith('view:p43##p43:') || nk.startsWith('param##')) state[nk] = v;
  }
  return { ...state, ...overrides };
}

/** Convenience: the two params every push threads through, given the SF ids. */
export function contactParam(guid, contactId) {
  return { [`param##${guid}`]: contactId };
}
