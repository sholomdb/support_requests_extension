import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  catalogItemNames,
  isCatalogBudget,
  budgetHasItem,
  catalogMaxPrice,
} from '../extension/shared/catalog-data.js';

describe('catalog-data', () => {
  test('has all six budgets, keyed by their canonical labels', () => {
    const budgets = Object.keys(CATALOG).sort();
    assert.deepEqual(budgets, [
      'אזרחים ותיקים',
      'בתי משפט קהילתיים',
      'ניצולי שואה',
      'נפגעי אלימות במשפחה',
      'סיוע חירום למשפחות',
      'של"מ',
    ]);
  });

  test('every budget has many items; each price is a positive number or null (no limit)', () => {
    for (const [budget, items] of Object.entries(CATALOG)) {
      const names = Object.keys(items);
      assert.ok(names.length > 50, `${budget} should have many items`);
      for (const n of names) {
        const p = items[n];
        assert.ok(p === null || p > 0, `${budget}/${n} price should be > 0 or null`);
      }
    }
  });

  test('catalogItemNames returns a de-duplicated union across budgets', () => {
    const names = catalogItemNames();
    assert.ok(names.length > 100);
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
    assert.ok(names.includes('מזון (סופר,מכולת,ספק מזון)'));
  });

  test('isCatalogBudget recognises known budgets and rejects unknown', () => {
    assert.equal(isCatalogBudget('של"מ'), true);
    assert.equal(isCatalogBudget('  סיוע חירום למשפחות  '), true); // normalized
    assert.equal(isCatalogBudget('תקציב לא קיים'), false);
  });

  test('budgetHasItem is budget-specific', () => {
    assert.equal(budgetHasItem('סיוע חירום למשפחות', 'מקרר'), true);
    assert.equal(budgetHasItem('בתי משפט קהילתיים', 'אבחון פסיכולוגי לילדים'), false);
    assert.equal(budgetHasItem('תקציב לא קיים', 'מקרר'), false);
  });

  test('catalogMaxPrice returns the per-budget price or null', () => {
    assert.equal(catalogMaxPrice('סיוע חירום למשפחות', 'מזון (סופר,מכולת,ספק מזון)'), 5000);
    assert.equal(catalogMaxPrice('סיוע חירום למשפחות', 'גלאי עשן'), 500);
    assert.equal(catalogMaxPrice('סיוע חירום למשפחות', 'פריט לא קיים'), null);
    assert.equal(catalogMaxPrice('תקציב לא קיים', 'מקרר'), null);
  });
});
