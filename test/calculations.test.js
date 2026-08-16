const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSale } = require('../src/calculations');

test('stack is included in sold litres and positive driver reconciles by addition', () => {
  const sale = calculateSale({
    amountInLitre: 100,
    m1L: 107,
    stak: 2,
    driversNafta: 3,
    buyPricePerLitre: 1,
    sellPricePerLitre: 1,
  }, { m1L: 0 });

  assert.equal(sale.soldInLiter, 109);
  assert.equal(sale.differenceInLitre, 6);
  assert.equal(sale.soldInLiter, 100 + 6 + 3);
});

test('negative driver litres are deducted during reconciliation', () => {
  const sale = calculateSale({
    amountInLitre: 100,
    m1L: 110,
    driversNafta: -2,
    buyPricePerLitre: 1,
    sellPricePerLitre: 1,
  }, { m1L: 0 });

  assert.equal(sale.soldInLiter, 110);
  assert.equal(sale.differenceInLitre, 12);
  assert.equal(sale.soldInLiter, 100 + 12 - 2);
  assert.equal(sale.driversNaftaBirr, -2);
});
