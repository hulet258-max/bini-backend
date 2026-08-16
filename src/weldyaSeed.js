/**
 * Exact fuel data transcribed from WELDYA.xlsx and ARSI.xlsx.
 *
 * Neither workbook supplies dates or dispatch numbers, so those fields stay
 * null. Blank numeric spreadsheet cells map to zero because the sales schema
 * intentionally stores those columns as NOT NULL numeric values.
 */

const STATION_SEEDS = [
  {
    id: 'weldeya',
    name: 'Weldeya',
    leftMachineCount: 2,
    rightMachineCount: 2,
    fuels: {
      nafta: {
        baseline: { m1L: 3061808, m1R: 5514380, m2L: 3180024, m2R: 3277084 },
        rows: [
          [47256,8331232.8,3088885,5536641,3180024,3277084,49338,0,1779,303,8747627.4,53418.9,799412,362975.7,9493620.5],
          [48518,8553723.4,3105310,5571975,3180024,3277084,51759,0,3086,155,9176870.7,27326.5,716795,595820.800000001,9866339.2],
          [48698,8585457.4,3105310,5571975,3229017,3277084,50267,1274,1201,368,8912339.1,64878.4,893138,262003.300000001,9740598.7],
          [48444,8540677.2,3134016,5595455,3229017,3277084,53388,1202,4721,223,9465692.4,39314.9,1023662,885700.299999999,10450039.5],
          [48439,8539795.7,3167214,5612866,3229017,3277084,50609,0,1820,350,8972975.7,61705,626104,371475,9537374.7],
          [48755,8595506.5,3198889,5631096,3229017,3277084,53091,3186,3995,341,9413034.3,60118.3,1081697,757409.500000001,10434613],
          [48234,8503654.2,3216641,5661812,3229017,3277084,51567,3099,2976,357,9142829.1,62939.1,1213414,576235.8,10293304],
          [48702,8586162.6,3216641,5661812,3229017,3324945,50874,3013,1682,490,9019960.2,86387,1167303,347410.600000001,10100876.2],
          [48198,8497307.4,3224701,5702730,3229017,3324945,51543,2565,2967,378,9138573.9,66641.4,753742,574625.1,9825674.5],
          [48704,8586515.2,3224701,5702730,3229017,3373023,51973,3895,3234,35,9214812.9,6170.5,720891,622127.199999999,9929533.4],
          [48307,8516524.1,3234858,5740512,3229017,3373023,51754,3815,3104,343,9175984.2,60470.9,871237,598989.200000001,9986750.3],
        ].map((values) => compactRow(values, 176.3, 177.3)),
      },
      benzine: {
        baseline: { m1L: 3229116, m1R: 0, m2L: 0, m2R: 0 },
        rows: [compactRow(
          [48529,0,3277019,0,0,0,49063,1160,534,0,0,377,525687,0,0],
          0,
          0
        )],
      },
    },
  },
  {
    id: 'arsi',
    name: 'Arsi',
    leftMachineCount: 2,
    rightMachineCount: 2,
    fuels: {
      nafta: {
        baseline: { m1L: 90091, m1R: 260814, m2L: 884, m2R: 482460 },
        rows: [
          [45849,8268830.4708,90091,260814,9528,524336,50520,0,4808,-137,9155739.6,-24828.51,0,911737.639199999,9180568.11],
          [47752,8612034.9984,90091,260814,9528,576865,52529,0,5242,-465,9519830.67,-84271.95,0,992067.621600001,9604102.62],
          [47526,8571276.0792,90091,260814,9528,629788,52923,0,5457,-60,9591235.29,-10873.8,0,1030833.0108,9602109.09],
          [46946,8466673.5432,90091,260814,9528,681729,51941,0,4995,0,9413267.43,0,0,946593.8868,9413267.43],
          [46820,8443949.544,90091,260814,9528,733495,51766,0,5035,-89,9381552.18,-16129.47,0,953732.106,9397681.65],
          [49658,8955780.5736,90091,260814,9528,787404,53909,0,4627,-376,9769928.07,-68142.48,0,882289.976400001,9838070.55],
        ].map((values) => compactRow(values, 180.3492, 181.23)),
      },
      benzine: {
        baseline: { m1L: 231742, m1R: 15843, m2L: 0, m2R: 0 },
        rows: [],
      },
    },
  },
];

function assertSpreadsheetRules() {
  const close = (left, right) => Math.abs(left - right) < 0.0001;
  for (const station of STATION_SEEDS) {
    for (const [fuelType, fuel] of Object.entries(station.fuels)) {
      let previous = {
        m1_l: fuel.baseline.m1L,
        m1_r: fuel.baseline.m1R,
        m2_l: fuel.baseline.m2L,
        m2_r: fuel.baseline.m2R,
      };
      fuel.rows.forEach((row, index) => {
        const sourceRow = index + 1;
        const meterSold =
          row.m1_l - previous.m1_l + row.m1_r - previous.m1_r +
          row.m2_l - previous.m2_l + row.m2_r - previous.m2_r + row.stak;
        const reconciledSold =
          row.amount_in_litre + row.difference_in_litre + row.drivers_nafta;
        if (row.sold_in_liter <= row.amount_in_litre) {
          throw new Error(`${station.id}/${fuelType} row ${sourceRow}: sold litres must exceed loaded litres`);
        }
        if (!close(row.sold_in_liter, meterSold)) {
          throw new Error(`${station.id}/${fuelType} row ${sourceRow}: stack/meter sold-litres mismatch`);
        }
        if (!close(row.sold_in_liter, reconciledSold)) {
          throw new Error(`${station.id}/${fuelType} row ${sourceRow}: signed-driver reconciliation mismatch`);
        }
        previous = row;
      });
    }
  }
}

assertSpreadsheetRules();

function compactRow(values, buyPricePerLitre, sellPricePerLitre) {
  const [
    amount_in_litre, paid, m1_l, m1_r, m2_l, m2_r, sold_in_liter,
    stak, difference_in_litre, drivers_nafta, sale_amount_birr,
    drivers_nafta_birr, black, profit, diff_in_birr,
  ] = values;
  return {
    sale_date: null,
    dispatch_no: null,
    amount_in_litre,
    paid,
    m1_l,
    m1_r,
    m2_l,
    m2_r,
    sold_in_liter,
    stak,
    difference_in_litre,
    drivers_nafta,
    sale_amount_birr,
    drivers_nafta_birr,
    black,
    profit,
    diff_in_birr,
    buy_price_per_litre: buyPricePerLitre,
    sell_price_per_litre: sellPricePerLitre,
  };
}

module.exports = {
  STATION_SEEDS,
  SEED_VERSION: 'weldya_arsi_v2',
};
