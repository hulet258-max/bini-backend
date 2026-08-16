/**
 * Formulas mirrored from WELDYA.xlsx (NAFTA sheet).
 *
 * Default unit prices (birr per litre):
 *   buy  = 180.3492  → paid to provider
 *   sell = 181.23    → sale amount from pump sales
 *
 * paid            = loaded_litres * buyPrice
 * sold_in_liter   = (M1L-prev)+(M1R-prev)+(M2L-prev)+(M2R-prev)+stack
 * difference_l    = sold − loaded − driver_fuel
 * sale_amount     = sold * sellPrice
 * driver_fuel_b   = driver_fuel * sellPrice
 * profit          = sale_amount − paid − driver_fuel_birr
 * diff_in_birr    = sale − adj_n − adj_o − adj_p − adj_q − driver_fuel_birr + black
 */

const BUY_PRICE_PER_LITRE = 180.3492;
const SELL_PRICE_PER_LITRE = 181.23;

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * @param {object} input - raw user / row fields
 * @param {object} prevMeters - previous row meter readings { m1L, m1R, m2L, m2R }
 */
function calculateSale(input, prevMeters = {}) {
  const buyPrice = num(input.buyPricePerLitre, BUY_PRICE_PER_LITRE);
  const sellPrice = num(input.sellPricePerLitre, SELL_PRICE_PER_LITRE);

  const amountInLitre = num(input.amountInLitre);
  const m1L = num(input.m1L);
  const m1R = num(input.m1R);
  const m2L = num(input.m2L);
  const m2R = num(input.m2R);
  const stak = num(input.stak);
  const driversNafta = num(input.driversNafta);
  const black = num(input.black);
  const adjN = num(input.adjN);
  const adjO = num(input.adjO);
  const adjP = num(input.adjP);
  const adjQ = num(input.adjQ);

  const prevM1L = num(prevMeters.m1L);
  const prevM1R = num(prevMeters.m1R);
  const prevM2L = num(prevMeters.m2L);
  const prevM2R = num(prevMeters.m2R);

  const paid = round2(amountInLitre * buyPrice);
  const soldInLiter = round2(
    m1L - prevM1L + (m1R - prevM1R) + (m2L - prevM2L) + (m2R - prevM2R) + stak
  );
  const differenceInLitre = round2(soldInLiter - amountInLitre - driversNafta);
  const saleAmountBirr = round2(soldInLiter * sellPrice);
  const driversNaftaBirr = round2(driversNafta * sellPrice);
  const profit = round2(saleAmountBirr - paid - driversNaftaBirr);
  const diffInBirr = round2(
    saleAmountBirr - adjN - adjO - adjP - adjQ - driversNaftaBirr + black
  );

  return {
    buyPricePerLitre: buyPrice,
    sellPricePerLitre: sellPrice,
    amountInLitre,
    paid,
    m1L,
    m1R,
    m2L,
    m2R,
    soldInLiter,
    stak,
    differenceInLitre,
    driversNafta,
    saleAmountBirr,
    adjN,
    adjO,
    adjP,
    adjQ,
    driversNaftaBirr,
    black,
    profit,
    diffInBirr,
  };
}

module.exports = {
  BUY_PRICE_PER_LITRE,
  SELL_PRICE_PER_LITRE,
  calculateSale,
  num,
  round2,
};
