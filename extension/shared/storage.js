/**
 * Per-city balance history and session state.
 *
 * session shape (chrome.storage.local key "session"):
 *   {
 *     parsedFile: { fileId, fileName, city, cities, totalAmount, parsedAt,
 *                   rows: [...pipeline.buildRow() output] },
 *     requests: [...pipeline.buildRequests() output, each with its own `steps`],
 *     currentIndex: number,     // index into requests
 *     log: [{ ts, message }],   // persisted fill log, exportable
 *     startedAt: string,
 *   }
 */

export async function getCityBalance(city) {
  const key = `balance_${city}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

export async function saveCityBalance(city, balance, note = '') {
  const key = `balance_${city}`;
  const entry = {
    balance: Number(balance),
    updatedAt: new Date().toISOString(),
    note,
  };
  await chrome.storage.local.set({ [key]: entry });

  const historyKey = `balance_history_${city}`;
  const { [historyKey]: history = [] } = await chrome.storage.local.get(historyKey);
  history.unshift(entry);
  await chrome.storage.local.set({ [historyKey]: history.slice(0, 50) });
  return entry;
}

export async function getBalanceHistory(city) {
  const historyKey = `balance_history_${city}`;
  const { [historyKey]: history = [] } = await chrome.storage.local.get(historyKey);
  return history;
}

/**
 * Per-budget-source remaining balances: { [sourceName]: number }. This is the pool the
 * upload-time allocator (pipeline.allocateSources) draws down when planning which source
 * funds each request. Populated from the site's home-page "budget sources" table (see
 * content.captureBudgetSourceRemaining) or set/imported manually until that capture is wired.
 * A source name is globally unique (each city+budget owns a disjoint set), so one flat map
 * is unambiguous.
 */
export async function getBudgetSourceRemaining() {
  const { budgetSourceRemaining } = await chrome.storage.local.get('budgetSourceRemaining');
  return budgetSourceRemaining || {};
}

export async function saveBudgetSourceRemaining(map = {}) {
  await chrome.storage.local.set({ budgetSourceRemaining: map });
  return map;
}

export async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null;
}

export async function saveSession(session) {
  await chrome.storage.local.set({ session });
}

export async function clearSession() {
  await chrome.storage.local.remove('session');
}

/** Marks one step as filled for a request; "row done" = all three steps filled. */
export async function setStepStatus(session, requestId, step, status) {
  if (!session) return;
  const request = session.requests.find((r) => r.requestId === requestId);
  if (!request) return session;
  request.steps[step] = status;
  await saveSession(session);
  return session;
}

export function isRequestDone(request) {
  return [1, 2, 3].every((step) => request.steps[step] === 'filled');
}

/** Appends to the persisted, exportable fill log (survives popup close/reopen). */
export async function appendLog(session, message) {
  if (!session) return;
  session.log = session.log || [];
  session.log.unshift({ ts: new Date().toISOString(), message });
  await saveSession(session);
  return session;
}

export async function verifyBalance(city, expectedDeduction, currentBalance, previousBalanceInput) {
  const stored = await getCityBalance(city);
  const prevBalance = Number(previousBalanceInput);
  const currBalance = Number(currentBalance);
  const expected = Number(expectedDeduction);

  const actualDeduction = prevBalance - currBalance;
  const results = {
    city,
    storedPreviousBalance: stored?.balance ?? null,
    inputPreviousBalance: prevBalance,
    currentBalance: currBalance,
    expectedDeduction: expected,
    actualDeduction,
    sumMatches: Math.abs(actualDeduction - expected) < 0.01,
    previousMatchesStored: stored ? Math.abs(stored.balance - prevBalance) < 0.01 : null,
    budgetAddition: stored && stored.balance !== prevBalance ? prevBalance - stored.balance : 0,
  };

  if (results.sumMatches) {
    await saveCityBalance(city, currBalance, `לאחר הזנת קובץ – הופחת ${expected} ₪`);
  }

  return results;
}
