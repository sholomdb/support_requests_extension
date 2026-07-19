import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { findCityLoginId } = await import('../extension/shared/config.js');

describe('findCityLoginId', () => {
  test('returns the login id for the matching city', () => {
    const cities = { 'ביתר עילית': { loginId: '063203442', slug: 'beytar' } };
    assert.equal(findCityLoginId(cities, 'ביתר עילית'), '063203442');
  });

  test('an empty-id placeholder entry does not shadow the configured one', () => {
    // Same normalized name appears twice (e.g. a built-in default with '' plus the
    // operator's configured entry). The one with an actual id must win.
    const cities = {
      'ביתר עילית': { loginId: '', slug: 'beytar' },
      'ביתר עילית ': { loginId: '063203442', slug: 'beytar' },
    };
    assert.equal(findCityLoginId(cities, 'ביתר עילית'), '063203442');
  });

  test('matches by slug when the name differs', () => {
    const cities = { 'מודיעין עילית': { loginId: '111', slug: 'modiin' } };
    assert.equal(findCityLoginId(cities, 'modiin'), '111');
  });

  test('returns empty string when no city has a login id', () => {
    const cities = { 'אלעד': { loginId: '', slug: 'elad' } };
    assert.equal(findCityLoginId(cities, 'אלעד'), '');
  });

  test('returns empty string for an unknown city', () => {
    assert.equal(findCityLoginId({ 'אלעד': { loginId: '5' } }, 'חיפה'), '');
  });
});
