const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const XLSX = require('xlsx');
const { STATION_SEEDS } = require('../src/weldyaSeed');

const columns = [
  'amount_in_litre', 'paid', 'm1_l', 'm1_r', 'm2_l', 'm2_r',
  'sold_in_liter', 'stak', 'difference_in_litre', 'drivers_nafta',
  'sale_amount_birr', 'drivers_nafta_birr', 'black', 'profit', 'diff_in_birr',
];

function workbook(name) {
  return XLSX.readFile(path.join(__dirname, '..', '..', name));
}

function values(sheet, rowNumber, sourceColumns) {
  return sourceColumns.map((column) =>
    column ? (sheet[`${column}${rowNumber}`]?.v ?? 0) : 0
  );
}

function seededValues(row) {
  return columns.map((column) => row[column]);
}

test('Weldya Nafta rows match every source spreadsheet column', () => {
  const book = workbook('WELDYA.xlsx');
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = STATION_SEEDS.find((station) => station.id === 'weldeya').fuels.nafta.rows;
  const sourceColumns = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'];

  assert.equal(rows.length, 11);
  rows.forEach((row, index) => {
    assert.deepEqual(seededValues(row), values(sheet, index + 3, sourceColumns));
  });
});

test('Arsi Nafta rows match every source spreadsheet column', () => {
  const book = workbook('ARSI.xlsx');
  const sheet = book.Sheets[book.SheetNames[1]];
  const rows = STATION_SEEDS.find((station) => station.id === 'arsi').fuels.nafta.rows;
  // Arsi has no stack or black-market columns, so those schema values are zero.
  const sourceColumns = ['A','B','C','D','E','F','G',null,'H','I','J','K',null,'L','M'];

  assert.equal(rows.length, 6);
  rows.forEach((row, index) => {
    assert.deepEqual(seededValues(row), values(sheet, index + 4, sourceColumns));
  });
});

test('Benzine row and all four station/fuel baselines match the workbooks', () => {
  const weldyaBook = workbook('WELDYA.xlsx');
  const arsiBook = workbook('ARSI.xlsx');
  const weldya = STATION_SEEDS.find((station) => station.id === 'weldeya');
  const arsi = STATION_SEEDS.find((station) => station.id === 'arsi');

  assert.deepEqual(weldya.fuels.nafta.baseline,
    { m1L: 3061808, m1R: 5514380, m2L: 3180024, m2R: 3277084 });
  assert.deepEqual(weldya.fuels.benzine.baseline,
    { m1L: 3229116, m1R: 0, m2L: 0, m2R: 0 });
  assert.deepEqual(arsi.fuels.nafta.baseline,
    { m1L: 90091, m1R: 260814, m2L: 884, m2R: 482460 });
  assert.deepEqual(arsi.fuels.benzine.baseline,
    { m1L: 231742, m1R: 15843, m2L: 0, m2R: 0 });

  const sheet = weldyaBook.Sheets[weldyaBook.SheetNames[1]];
  const benzine = weldya.fuels.benzine.rows[0];
  assert.deepEqual(seededValues(benzine), [
    sheet.C5.v, 0, sheet.E5.v, 0, 0, 0, sheet.I5.v, sheet.J5.v,
    sheet.K5.v, 0, 0, sheet.R5.v, sheet.S5.v, 0, 0,
  ]);
  assert.equal(arsiBook.Sheets[arsiBook.SheetNames[2]].E4.v, arsi.fuels.benzine.baseline.m1L);
  assert.equal(arsi.fuels.benzine.rows.length, 0);
});

test('rows run oldest-to-newest and obey sold, stack, and signed-driver rules', () => {
  for (const station of STATION_SEEDS) {
    for (const fuel of Object.values(station.fuels)) {
      let previous = {
        m1_l: fuel.baseline.m1L, m1_r: fuel.baseline.m1R,
        m2_l: fuel.baseline.m2L, m2_r: fuel.baseline.m2R,
      };
      for (const row of fuel.rows) {
        const meterSold = row.m1_l - previous.m1_l + row.m1_r - previous.m1_r +
          row.m2_l - previous.m2_l + row.m2_r - previous.m2_r + row.stak;
        assert.ok(row.sold_in_liter > row.amount_in_litre);
        assert.equal(row.sold_in_liter, meterSold);
        assert.equal(
          row.sold_in_liter,
          row.amount_in_litre + row.difference_in_litre + row.drivers_nafta
        );
        previous = row;
      }
    }
  }

  const arsiRows = STATION_SEEDS.find((station) => station.id === 'arsi').fuels.nafta.rows;
  assert.ok(arsiRows[0].drivers_nafta < 0);
  assert.equal(arsiRows[0].sold_in_liter, 45849 + 4808 - 137);
  assert.equal(arsiRows.at(-1).m2_r, 787404, 'bottom workbook row must remain newest');
});
