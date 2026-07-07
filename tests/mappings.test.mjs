import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers/chrome-stub.mjs';

installChromeStub();
const {
  MAP_TYPES,
  mappingKey,
  saveMapping,
  deleteMapping,
  resolveMapping,
  getSuggestions,
  addCategory,
  removeCategory,
  HARDCODED_SUGGESTIONS,
  buildBudgetSourceKey,
  listMappingsFlat,
  getItemMaxPrice,
  setItemInfo,
  exportMappingData,
  importMappingData,
} = await import('../extension/shared/mappings.js');
const { catalogItemNames, catalogMaxPrice } = await import('../extension/shared/catalog-data.js');

function resetStorage() {
  installChromeStub();
}

describe('mappingKey', () => {
  test('plain types key on normalized excel value', () => {
    assert.equal(mappingKey(MAP_TYPES.city, '  אלעד  '), 'אלעד');
  });
  test('budgetSource keys on budgetType+city from context, ignoring excelValue', () => {
    const key = mappingKey(MAP_TYPES.budgetSource, 'ignored', { budgetType: 'משפחות', city: 'ביתר' });
    assert.equal(key, 'משפחות::ביתר עילית');
  });
  test('familyClassification keys on householdSize+maritalStatus from context', () => {
    const key = mappingKey(MAP_TYPES.familyClassification, 'ignored', { householdSize: 3, maritalStatus: 'נשוי/אה' });
    assert.equal(key, '3::נשוי/אה');
  });
  test('buildBudgetSourceKey matches mappingKey', () => {
    assert.equal(
      buildBudgetSourceKey('משפחות', 'ביתר'),
      mappingKey(MAP_TYPES.budgetSource, 'משפחות', { budgetType: 'משפחות', city: 'ביתר' })
    );
  });
});

describe('resolveMapping', () => {
  beforeEach(resetStorage);

  test('resolves from seed defaults when nothing is saved', async () => {
    const result = await resolveMapping(MAP_TYPES.city, 'אלעד');
    assert.equal(result.needsInput, undefined);
    assert.equal(result.siteValue, 'אלעד');
    assert.equal(result.fromSeed, true);
  });

  test('unknown value needs input and carries suggestions', async () => {
    const result = await resolveMapping(MAP_TYPES.city, 'עיר שלא קיימת בשום מקום');
    assert.equal(result.needsInput, true);
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.suggestions.includes('אלעד'));
  });

  test('a saved operator mapping takes priority over a seed', async () => {
    await saveMapping(MAP_TYPES.city, 'אלעד', 'שם אחר לגמרי');
    const result = await resolveMapping(MAP_TYPES.city, 'אלעד');
    assert.equal(result.siteValue, 'שם אחר לגמרי');
    assert.equal(result.fromUser, true);
  });

  test('deleteMapping removes a saved mapping and falls back to the seed again', async () => {
    await saveMapping(MAP_TYPES.city, 'אלעד', 'שם אחר לגמרי');
    await deleteMapping(MAP_TYPES.city, 'אלעד');
    const result = await resolveMapping(MAP_TYPES.city, 'אלעד');
    assert.equal(result.fromSeed, true);
    assert.equal(result.siteValue, 'אלעד');
  });

  test('budgetType seed carries a labelIndex', async () => {
    const result = await resolveMapping(MAP_TYPES.budgetType, 'משפחות');
    assert.equal(result.labelIndex, 1);
  });

  test('budgetSource has no seed and needs input by default', async () => {
    const result = await resolveMapping(MAP_TYPES.budgetSource, 'ignored', {
      budgetType: 'משפחות',
      city: 'בני ברק',
    });
    assert.equal(result.needsInput, true);
  });

  test('listMappingsFlat reflects saved mappings', async () => {
    await saveMapping(MAP_TYPES.item, 'מקרר', 'מקרר קטן');
    const rows = await listMappingsFlat();
    assert.ok(rows.some((r) => r.type === MAP_TYPES.item && r.siteValue === 'מקרר קטן'));
  });
});

describe('categorical suggestions (item/budgetSource growth)', () => {
  beforeEach(resetStorage);

  test('budgetSource starts with no suggestions; item is seeded with every catalog item', async () => {
    assert.deepEqual(await getSuggestions(MAP_TYPES.budgetSource), []);
    const itemSuggestions = await getSuggestions(MAP_TYPES.item);
    for (const name of catalogItemNames()) assert.ok(itemSuggestions.includes(name));
  });

  test('saving a mapping for item makes its site value a future suggestion', async () => {
    await saveMapping(MAP_TYPES.item, 'מקרר', 'מקרר קטן');
    const suggestions = await getSuggestions(MAP_TYPES.item);
    assert.ok(suggestions.includes('מקרר קטן'));
  });

  test('saving the same site value twice does not duplicate the suggestion', async () => {
    await saveMapping(MAP_TYPES.item, 'מקרר', 'מקרר קטן');
    await saveMapping(MAP_TYPES.item, 'מקרר גדול', 'מקרר קטן');
    const suggestions = await getSuggestions(MAP_TYPES.item);
    assert.equal(suggestions.filter((s) => s === 'מקרר קטן').length, 1);
  });

  test('addCategory lets an operator pre-add a value before it is ever used', async () => {
    await addCategory(MAP_TYPES.budgetSource, 'סיוע חירום למשפחות תכנית סיוע חומרי בני ברק 2026');
    const suggestions = await getSuggestions(MAP_TYPES.budgetSource);
    assert.ok(suggestions.includes('סיוע חירום למשפחות תכנית סיוע חומרי בני ברק 2026'));
  });

  test('removeCategory removes an operator-added value but not the catalog seed', async () => {
    const before = await getSuggestions(MAP_TYPES.item);
    await addCategory(MAP_TYPES.item, 'מקרר קטן דמיוני');
    await removeCategory(MAP_TYPES.item, 'מקרר קטן דמיוני');
    assert.deepEqual(await getSuggestions(MAP_TYPES.item), before);
  });

  test('removeCategory cannot remove a built-in suggestion', async () => {
    const builtIn = HARDCODED_SUGGESTIONS[MAP_TYPES.city][0];
    await removeCategory(MAP_TYPES.city, builtIn);
    const suggestions = await getSuggestions(MAP_TYPES.city);
    assert.ok(suggestions.includes(builtIn));
  });

  test('suggestions never contain duplicates across built-in + stored', async () => {
    const builtIn = HARDCODED_SUGGESTIONS[MAP_TYPES.budgetType][0];
    await addCategory(MAP_TYPES.budgetType, builtIn);
    const suggestions = await getSuggestions(MAP_TYPES.budgetType);
    assert.equal(suggestions.filter((s) => s === builtIn).length, 1);
  });

  test('a known catalog item is a suggestion out of the box', async () => {
    const suggestions = await getSuggestions(MAP_TYPES.item);
    assert.ok(suggestions.includes('מזון (סופר,מכולת,ספק מזון)'));
  });

  test('a catalog item name resolves to itself via a seed (no prompt)', async () => {
    const known = catalogItemNames()[0];
    const result = await resolveMapping(MAP_TYPES.item, known);
    assert.equal(result.needsInput, undefined);
    assert.equal(result.siteValue, known);
    assert.equal(result.fromSeed, true);
  });
});

describe('operator item info (getItemMaxPrice / setItemInfo)', () => {
  beforeEach(resetStorage);

  test('no operator override -> null (catalog price is applied in the pipeline, not here)', async () => {
    assert.equal(await getItemMaxPrice('מזון (סופר,מכולת,ספק מזון)'), null);
    assert.equal(await getItemMaxPrice('פריט שלא קיים בשום מקום'), null);
  });

  test('setItemInfo records an operator maxPrice override', async () => {
    await setItemInfo('פריט מותאם', { selector: '#e999', maxPrice: 1234 });
    assert.equal(await getItemMaxPrice('פריט מותאם'), 1234);
  });
});

describe('exportMappingData / importMappingData (settings JSON round-trip)', () => {
  beforeEach(resetStorage);

  test('export captures saved mappings, categories, and item info', async () => {
    await saveMapping(MAP_TYPES.item, 'מקרר', 'מקרר גדול');
    await addCategory(MAP_TYPES.budgetSource, 'מקור לדוגמה');
    await setItemInfo('מקרר גדול', { selector: '#e1', maxPrice: 3000 });

    const data = await exportMappingData();
    assert.ok(data.valueMappings.item);
    assert.ok(data.categories.budgetSource.includes('מקור לדוגמה'));
    assert.equal(data.itemCatalog['מקרר גדול'].maxPrice, 3000);
  });

  test('import restores everything into a fresh (empty) storage', async () => {
    await saveMapping(MAP_TYPES.item, 'מקרר', 'מקרר גדול');
    await addCategory(MAP_TYPES.budgetSource, 'מקור לדוגמה');
    await setItemInfo('מקרר גדול', { selector: '#e1', maxPrice: 3000 });
    const snapshot = await exportMappingData();

    resetStorage();
    assert.deepEqual(await getSuggestions(MAP_TYPES.budgetSource), []);

    await importMappingData(snapshot);
    assert.ok((await getSuggestions(MAP_TYPES.budgetSource)).includes('מקור לדוגמה'));
    assert.equal(await getItemMaxPrice('מקרר גדול'), 3000);
    const rows = await listMappingsFlat();
    assert.ok(rows.some((r) => r.siteValue === 'מקרר גדול'));
  });

  test('importMappingData ignores keys that are absent from the file', async () => {
    await addCategory(MAP_TYPES.item, 'קיים');
    await importMappingData({ valueMappings: { city: { x: { siteValue: 'y' } } } });
    // categories untouched (not in the imported object)
    assert.ok((await getSuggestions(MAP_TYPES.item)).includes('קיים'));
  });
});
