const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSummary, validateDay } = require('../src/fuelRoutes');

test('daily meter deltas are the sold-litres source of truth', () => {
  const result = validateDay({
    date: '2026-08-14',
    meters: {
      m1L: { end: 125 }, m1R: { end: 230 }, m2L: { end: 300 }, m2R: { end: 405 },
    },
    stackLitres: 2,
    blackLitres: 10,
  }, { m1L: 100, m1R: 200, m2L: 300, m2R: 400 });
  assert.equal(result.sold, 62);
  assert.equal(result.blackLitres, 10);
});

test('meters cannot move backwards', () => {
  const result = validateDay({
    date: '2026-08-14', meters: { m1L: { end: 99 } },
  }, { m1L: 100, m1R: 0, m2L: 0, m2R: 0 });
  assert.match(result.error, /cannot go backwards/);
});

test('black litres must be part of pump litres', () => {
  const result = validateDay({
    date: '2026-08-14', blackLitres: 11,
    meters: { m1L: { end: 10 }, m1R: { end: 0 }, m2L: { end: 0 }, m2R: { end: 0 } },
  }, { m1L: 0, m1R: 0, m2L: 0, m2R: 0 });
  assert.match(result.error, /cannot exceed/);
});

test('inactive machines stay at their previous last reading', () => {
  const result = validateDay({
    date: '2026-08-14',
    meters: { m1L: { end: 125 }, m1R: { end: 9999 } },
  }, { m1L: 100, m1R: 200, m2L: 300, m2R: 400 }, ['m1L']);
  assert.equal(result.sold, 25);
  assert.equal(result.ends.m1R, 200);
});

test('active machines require a new last reading', () => {
  const result = validateDay({
    date: '2026-08-14', meters: { m1L: { end: '' } },
  }, { m1L: 100, m1R: 200, m2L: 300, m2R: 400 }, ['m1L']);
  assert.match(result.error, /new last reading/);
});

test('load reconciliation subtracts remittances, expenses and cash held', () => {
  const summary = loadSummary({
    day_count: 2, daily_sold: 100, daily_waste: 1, amount_in_litre: 120,
    opening_stock_litres: 5, drivers_nafta: 2, expected_revenue: 20000,
    telebirr_total: 10000, cbe_total: 5000, cash_total: 1000,
    expense_total: 500, cash_on_hand: 3500, paid: 15000, drivers_nafta_birr: 300,
  });
  assert.equal(summary.remainingLitres, 22);
  assert.equal(summary.totalRemitted, 16000);
  assert.equal(summary.cashGap, 0);
  assert.equal(summary.profit, 4200);
});
