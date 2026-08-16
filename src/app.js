const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
// Always load backend/.env (works even when cwd is backend/src)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initDatabase, getPool, mapSaleRow, mapTransportRow } = require('./db');
const { registerFuelRoutes } = require('./fuelRoutes');
const {
  calculateSale,
  BUY_PRICE_PER_LITRE,
  SELL_PRICE_PER_LITRE,
} = require('./calculations');

const app = express();
const PORT = process.env.PORT || 5000;
const APP_PIN = process.env.APP_PIN || '1234';
const ADMIN_PHONE = process.env.MOCK_ADMIN_PHONE || '0911111111';
const STATION_PHONE = process.env.MOCK_STATION_PHONE || '0922222222';
const STATION_USER_ID = process.env.MOCK_STATION_ID || 'weldeya';
const STATION_USER_NAME = process.env.MOCK_STATION_NAME || 'Weldeya';
const AUTH_SECRET = process.env.AUTH_SECRET || `${APP_PIN}:bini-mock-auth`;

app.use(cors());
app.use(express.json());

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith('9') && digits.length === 9) return `0${digits}`;
  return digits;
}

function encodeToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeToken(token) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.expiresAt > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function verifyPin(pin, stored) {
  try {
    const [salt, expectedHex] = String(stored || '').split(':');
    if (!salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(pin), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

app.post('/api/auth/login', async (req, res) => {
  const { phone, pin } = req.body || {};
  if (!pin) {
    return res.status(401).json({ success: false, message: 'Invalid phone number or PIN' });
  }

  const normalizedPhone = normalizePhone(phone);
  let user;
  if (normalizedPhone === normalizePhone(ADMIN_PHONE) && String(pin) === String(APP_PIN)) {
    user = { phone: normalizedPhone, role: 'admin', stationId: null, stationName: null };
  } else {
    const station = await getPool().query(
      `SELECT id, name, manager_phone, manager_pin_hash, left_machine_count, right_machine_count
       FROM stations WHERE manager_phone=$1 AND active=TRUE LIMIT 1`,
      [normalizedPhone]
    );
    if (!station.rowCount || !verifyPin(pin, station.rows[0].manager_pin_hash)) {
      return res.status(401).json({ success: false, message: 'Invalid phone number or PIN' });
    }
    const record = station.rows[0];
    user = {
      phone: normalizedPhone,
      role: 'station',
      stationId: record.id,
      stationName: record.name,
      leftMachineCount: Number(record.left_machine_count),
      rightMachineCount: Number(record.right_machine_count),
    };
  }

  const token = encodeToken({ ...user, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return res.json({ success: true, message: 'Login successful', token, user });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const user = decodeToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!user) return res.status(401).json({ success: false, message: 'Please log in again' });
  req.user = user;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'This account only has station access' });
  }
  next();
}

function requestedStation(req, source = 'query') {
  const requested = normalizeStationId(req[source]?.stationId);
  return req.user.role === 'station' ? req.user.stationId : requested;
}

async function canAccessSale(req, res, next) {
  if (req.user.role === 'admin') return next();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next();
  try {
    const result = await getPool().query('SELECT station_id FROM sales WHERE id = $1', [id]);
    if (result.rowCount && result.rows[0].station_id === req.user.stationId) return next();
    return res.status(403).json({ success: false, message: 'This sale belongs to another station' });
  } catch (err) {
    next(err);
  }
}

async function requireOpenSale(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next();
  try {
    const result = await getPool().query('SELECT status FROM sales WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Load not found' });
    if (result.rows[0].status !== 'open') {
      return res.status(409).json({ success: false, message: 'Closed loads are locked. Reopen the load before editing.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function normalizeFuelType(value) {
  const v = String(value || 'nafta').toLowerCase();
  return v === 'benzine' ? 'benzine' : 'nafta';
}

function normalizeStationId(value) {
  const v = String(value || 'weldeya').trim().toLowerCase();
  return v || 'weldeya';
}

registerFuelRoutes(app, { getPool, mapSaleRow, requireAdmin });

app.get('/api/meta', (_req, res) => {
  res.json({
    success: true,
    title: 'Fuel sales tracker',
    source: 'WELDYA.xlsx and ARSI.xlsx',
    prices: {
      buyPricePerLitre: BUY_PRICE_PER_LITRE,
      sellPricePerLitre: SELL_PRICE_PER_LITRE,
    },
    formulas: {
      paid: 'loaded_litres × buy_price_per_litre',
      soldInLiter: '(M1L−prev)+(M1R−prev)+(M2L−prev)+(M2R−prev)+stack',
      differenceInLitre: 'sold − loaded − driver_fuel',
      saleAmountBirr: 'sold × sell_price_per_litre',
      driversNaftaBirr: 'driver_fuel × sell_price_per_litre',
      profit: 'sale_amount − paid − driver_fuel_birr',
      diffInBirr: 'sale_amount − adj_n − adj_o − adj_p − adj_q − driver_fuel_birr + black',
    },
  });
});

/** Latest meter readings for station + fuel type (or fuel baseline). */
async function getPreviousMeters(stationId = 'weldeya', fuelType = 'nafta') {
  const pool = getPool();
  const last = await pool.query(
    `SELECT m1_l, m1_r, m2_l, m2_r
     FROM sales
     WHERE station_id = $1 AND fuel_type = $2
     ORDER BY sale_date DESC NULLS LAST, id DESC
     LIMIT 1`,
    [stationId, fuelType]
  );

  if (last.rowCount > 0) {
    const r = last.rows[0];
    return {
      m1L: Number(r.m1_l),
      m1R: Number(r.m1_r),
      m2L: Number(r.m2_l),
      m2R: Number(r.m2_r),
    };
  }

  const byFuel = await pool.query(
    `SELECT m1_l, m1_r, m2_l, m2_r
     FROM meter_baseline_by_fuel WHERE station_id = $1 AND fuel_type = $2`,
    [stationId, fuelType]
  );
  if (byFuel.rowCount > 0) {
    const r = byFuel.rows[0];
    return {
      m1L: Number(r.m1_l),
      m1R: Number(r.m1_r),
      m2L: Number(r.m2_l),
      m2R: Number(r.m2_r),
    };
  }

  if (fuelType === 'nafta') {
    const base = await pool.query(
      'SELECT m1_l, m1_r, m2_l, m2_r FROM meter_baseline WHERE id = 1'
    );
    if (base.rowCount > 0) {
      const r = base.rows[0];
      return {
        m1L: Number(r.m1_l),
        m1R: Number(r.m1_r),
        m2L: Number(r.m2_l),
        m2R: Number(r.m2_r),
      };
    }
  }

  return { m1L: 0, m1R: 0, m2L: 0, m2R: 0 };
}

app.get('/api/sales/previous-meters', async (req, res) => {
  try {
    const stationId = requestedStation(req);
    const fuelType = normalizeFuelType(req.query.fuelType);
    const meters = await getPreviousMeters(stationId, fuelType);
    res.json({ success: true, data: meters, stationId, fuelType });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to load meters' });
  }
});

app.post('/api/sales/preview', async (req, res) => {
  try {
    const body = req.body || {};
    const stationId = requestedStation(req, 'body');
    const fuelType = normalizeFuelType(body.fuelType);
    const prev = await getPreviousMeters(stationId, fuelType);
    const calc = calculateSale(body, prev);
    res.json({ success: true, data: calc, previousMeters: prev });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Preview failed' });
  }
});

app.get('/api/sales', async (req, res) => {
  try {
    const stationId = requestedStation(req);
    const fuelType = normalizeFuelType(req.query.fuelType);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM sales
       WHERE station_id = $1 AND fuel_type = $2
       ORDER BY sale_date DESC NULLS LAST, id DESC`,
      [stationId, fuelType]
    );

    const rows = result.rows.map(mapSaleRow);
    const totals = rows.reduce(
      (acc, r) => {
        acc.soldInLiter += r.soldInLiter;
        acc.amountInLitre += r.amountInLitre;
        acc.saleAmountBirr += r.saleAmountBirr;
        acc.profit += r.profit;
        acc.diffInBirr += r.diffInBirr;
        return acc;
      },
      { soldInLiter: 0, amountInLitre: 0, saleAmountBirr: 0, profit: 0, diffInBirr: 0 }
    );

    res.json({
      success: true,
      data: rows,
      total: rows.length,
      totals,
      stationId,
      fuelType,
    });
  } catch (err) {
    console.error('GET /api/sales error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch sales' });
  }
});

app.post('/api/sales', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.date) {
      return res.status(400).json({ success: false, message: 'date is required' });
    }

    const stationId = requestedStation(req, 'body');
    const fuelType = normalizeFuelType(body.fuelType);
    const prev = await getPreviousMeters(stationId, fuelType);
    const calc = calculateSale(body, prev);
    const pool = getPool();

    const result = await pool.query(
      `INSERT INTO sales (
        station_id, fuel_type,
        sale_date, dispatch_no, amount_in_litre, paid,
        m1_l, m1_r, m2_l, m2_r,
        sold_in_liter, stak, difference_in_litre, drivers_nafta,
        sale_amount_birr, adj_n, adj_o, adj_p, adj_q,
        drivers_nafta_birr, black, profit, diff_in_birr,
        buy_price_per_litre, sell_price_per_litre,
        qen, telebirr
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      )
      RETURNING *`,
      [
        stationId,
        fuelType,
        body.date,
        body.dispatchNo || null,
        calc.amountInLitre,
        calc.paid,
        calc.m1L,
        calc.m1R,
        calc.m2L,
        calc.m2R,
        calc.soldInLiter,
        calc.stak,
        calc.differenceInLitre,
        calc.driversNafta,
        calc.saleAmountBirr,
        calc.adjN,
        calc.adjO,
        calc.adjP,
        calc.adjQ,
        calc.driversNaftaBirr,
        calc.black,
        calc.profit,
        calc.diffInBirr,
        calc.buyPricePerLitre,
        calc.sellPricePerLitre,
        body.qen || null,
        body.telebirr || null,
      ]
    );

    res.status(201).json({ success: true, data: mapSaleRow(result.rows[0]) });
  } catch (err) {
    console.error('POST /api/sales error:', err);
    res.status(500).json({ success: false, message: 'Failed to create sale' });
  }
});

app.put('/api/sales/:id', canAccessSale, requireOpenSale, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid sale id' });
    }

    const body = req.body || {};
    if (!body.date) {
      return res.status(400).json({ success: false, message: 'date is required' });
    }

    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const pool = getPool();
    const result = await pool.query(
      `UPDATE sales SET
        sale_date=$1, dispatch_no=$2, amount_in_litre=$3, paid=$4,
        m1_l=$5, m1_r=$6, m2_l=$7, m2_r=$8,
        sold_in_liter=$9, stak=$10, difference_in_litre=$11, drivers_nafta=$12,
        sale_amount_birr=$13, adj_n=$14, adj_o=$15, adj_p=$16, adj_q=$17,
        drivers_nafta_birr=$18, black=$19, profit=$20, diff_in_birr=$21,
        buy_price_per_litre=$22, sell_price_per_litre=$23,
        qen=$24, telebirr=$25
       WHERE id=$26
       RETURNING *`,
      [
        body.date,
        body.dispatchNo || null,
        number(body.amountInLitre),
        number(body.paid),
        number(body.m1L),
        number(body.m1R),
        number(body.m2L),
        number(body.m2R),
        number(body.soldInLiter),
        number(body.stak),
        number(body.differenceInLitre),
        number(body.driversNafta),
        number(body.saleAmountBirr),
        number(body.adjN),
        number(body.adjO),
        number(body.adjP),
        number(body.adjQ),
        number(body.driversNaftaBirr),
        number(body.black),
        number(body.profit),
        number(body.diffInBirr),
        number(body.buyPricePerLitre) || BUY_PRICE_PER_LITRE,
        number(body.sellPricePerLitre) || SELL_PRICE_PER_LITRE,
        body.qen || null,
        body.telebirr || null,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    res.json({ success: true, data: mapSaleRow(result.rows[0]) });
  } catch (err) {
    console.error('PUT /api/sales/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update sale' });
  }
});

const TRANSFER_METHODS = ['telebirr', 'cbe', 'daily', 'expense'];

app.get('/api/sales/:id/transfers', canAccessSale, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid sale id' });
    }

    const result = await getPool().query(
      `SELECT method, position, transfer_date, amount, amount_end, machine, reason
       FROM money_transfers
       WHERE sale_id = $1
       ORDER BY method, position`,
      [id]
    );
    const data = {
      telebirr: [],
      cbe: [],
      daily: [],
      expense: [],
    };
    for (const row of result.rows) {
      const method = row.method === 'daily_start' || row.method === 'daily_end' ? 'daily' : row.method;
      if (!data[method]) data[method] = [];
      data[method].push({
        position: row.position,
        date: row.transfer_date ? row.transfer_date.toISOString().slice(0, 10) : '',
        amount: row.amount === null ? '' : String(row.amount),
        amountEnd: row.amount_end === null || row.amount_end === undefined ? '' : String(row.amount_end),
        machine: row.machine || '',
        reason: row.reason || '',
      });
    }
    // At least one blank row for editable lists
    for (const method of TRANSFER_METHODS) {
      if (!data[method] || data[method].length === 0) {
        data[method] = [{ date: '', amount: '', amountEnd: '', machine: '', reason: '', position: 1 }];
      }
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/sales/:id/transfers error:', err);
    res.status(500).json({ success: false, message: 'Failed to load money transfers' });
  }
});

app.put('/api/sales/:id/transfers/:method', canAccessSale, requireOpenSale, async (req, res) => {
  const method = String(req.params.method || '').toLowerCase();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || !TRANSFER_METHODS.includes(method)) {
    return res.status(400).json({ success: false, message: 'Invalid transfer request' });
  }

  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear new + legacy daily keys
    if (method === 'daily') {
      await client.query(
        `DELETE FROM money_transfers
         WHERE sale_id=$1 AND method IN ('daily', 'daily_start', 'daily_end')`,
        [id]
      );
    } else {
      await client.query('DELETE FROM money_transfers WHERE sale_id=$1 AND method=$2', [id, method]);
    }
    let position = 1;
    for (const entry of entries) {
      const date = entry.date || null;
      const amount = entry.amount === '' || entry.amount == null ? null : Number(entry.amount);
      const amountEnd =
        entry.amountEnd === '' || entry.amountEnd == null ? null : Number(entry.amountEnd);
      const machine = entry.machine || null;
      const reason = entry.reason || null;
      const hasContent =
        date || Number.isFinite(amount) || Number.isFinite(amountEnd) || machine || reason;
      if (hasContent) {
        await client.query(
          `INSERT INTO money_transfers
            (sale_id, method, position, transfer_date, amount, amount_end, machine, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            method,
            position,
            date,
            Number.isFinite(amount) ? amount : null,
            Number.isFinite(amountEnd) ? amountEnd : null,
            machine,
            reason,
          ]
        );
        position += 1;
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, message: 'Entries saved' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/sales/:id/transfers/:method error:', err);
    res.status(500).json({ success: false, message: 'Failed to save money transfers' });
  } finally {
    client.release();
  }
});

function normalizeOrgId(value) {
  const v = String(value || 'tele').trim().toLowerCase();
  return v || 'tele';
}

function toNumOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Transportation orgs: tele (tele.xlsx) + loaded (loaded .xlsx) + custom */
app.get('/api/transports/organizations', requireAdmin, async (_req, res) => {
  try {
    const result = await getPool().query(
      `SELECT org_id,COUNT(*)::int AS dispatch_count,
        COALESCE(SUM(total_price),0) AS total_price,
        MAX(id) AS latest_id
       FROM transports GROUP BY org_id ORDER BY org_id`
    );
    res.json({ success: true, data: result.rows.map((row) => ({
      id: row.org_id,
      dispatchCount: Number(row.dispatch_count),
      totalPrice: Number(row.total_price),
      latestId: Number(row.latest_id),
    })) });
  } catch (err) {
    console.error('GET /api/transports/organizations error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch transport organizations' });
  }
});

app.get('/api/transports/drivers', requireAdmin, async (_req, res) => {
  try {
    const result = await getPool().query(
      `SELECT DISTINCT ON (LOWER(COALESCE(NULLIF(driver_phone,''),driver_name)))
        driver_name,driver_phone,destination,org_id,plate,id
       FROM transports
       WHERE COALESCE(driver_name,'')<>'' OR COALESCE(driver_phone,'')<>''
       ORDER BY LOWER(COALESCE(NULLIF(driver_phone,''),driver_name)),id DESC`
    );
    res.json({ success: true, data: result.rows.map((row) => ({
      name: row.driver_name || 'Unnamed driver', phone: row.driver_phone || '',
      lastDestination: row.destination || '', orgId: row.org_id,
      plate: row.plate || '', lastDispatchId: Number(row.id),
    })) });
  } catch (err) {
    console.error('GET /api/transports/drivers error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch drivers' });
  }
});

app.get('/api/transports', requireAdmin, async (req, res) => {
  try {
    const orgId = normalizeOrgId(req.query.orgId);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM transports
       WHERE org_id = $1
       ORDER BY row_no ASC NULLS LAST, id ASC`,
      [orgId]
    );
    const rows = result.rows.map(mapTransportRow);
    const totals = rows.reduce(
      (acc, r) => {
        acc.quantity += r.quantity || 0;
        acc.totalPrice += r.totalPrice || 0;
        acc.rent += r.rent || 0;
        acc.deposit += r.deposit || 0;
        acc.remaining += r.remaining || 0;
        return acc;
      },
      { quantity: 0, totalPrice: 0, rent: 0, deposit: 0, remaining: 0 }
    );
    res.json({
      success: true,
      data: rows,
      total: rows.length,
      totals,
      orgId,
    });
  } catch (err) {
    console.error('GET /api/transports error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch transports' });
  }
});

app.post('/api/transports', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const orgId = normalizeOrgId(body.orgId);
    const pool = getPool();
    const maxNo = await pool.query(
      `SELECT COALESCE(MAX(row_no), 0)::int AS m FROM transports WHERE org_id = $1`,
      [orgId]
    );
    const rowNo = body.rowNo != null ? Number(body.rowNo) : maxNo.rows[0].m + 1;

    const result = await pool.query(
      `INSERT INTO transports (
        org_id, row_no, plate, vehicle_type, driver_name, driver_phone,
        destination, cargo_type, quantity, unit_price, km, total_price,
        rent, deposit, remaining
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      ) RETURNING *`,
      [
        orgId,
        rowNo,
        body.plate || null,
        body.vehicleType || null,
        body.driverName || null,
        body.driverPhone || null,
        body.destination || null,
        body.cargoType || null,
        toNumOrNull(body.quantity),
        toNumOrNull(body.unitPrice),
        toNumOrNull(body.km),
        toNumOrNull(body.totalPrice),
        toNumOrNull(body.rent),
        toNumOrNull(body.deposit),
        toNumOrNull(body.remaining),
      ]
    );
    res.status(201).json({ success: true, data: mapTransportRow(result.rows[0]) });
  } catch (err) {
    console.error('POST /api/transports error:', err);
    res.status(500).json({ success: false, message: 'Failed to create transport' });
  }
});

app.put('/api/transports/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid transport id' });
    }
    const body = req.body || {};
    const result = await getPool().query(
      `UPDATE transports SET
        row_no=$1, plate=$2, vehicle_type=$3, driver_name=$4, driver_phone=$5,
        destination=$6, cargo_type=$7, quantity=$8, unit_price=$9, km=$10,
        total_price=$11, rent=$12, deposit=$13, remaining=$14
       WHERE id=$15
       RETURNING *`,
      [
        body.rowNo != null ? Number(body.rowNo) : null,
        body.plate || null,
        body.vehicleType || null,
        body.driverName || null,
        body.driverPhone || null,
        body.destination || null,
        body.cargoType || null,
        toNumOrNull(body.quantity),
        toNumOrNull(body.unitPrice),
        toNumOrNull(body.km),
        toNumOrNull(body.totalPrice),
        toNumOrNull(body.rent),
        toNumOrNull(body.deposit),
        toNumOrNull(body.remaining),
        id,
      ]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Transport not found' });
    }
    res.json({ success: true, data: mapTransportRow(result.rows[0]) });
  } catch (err) {
    console.error('PUT /api/transports/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update transport' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'OK' });
});

async function start() {
  try {
    await initDatabase();
    // Bind 0.0.0.0 so the process accepts traffic inside Docker / EasyPanel
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    if (!process.env.DATABASE_URL && !process.env.PGPASSWORD) {
      console.error(
        'PGPASSWORD is missing. Set it in backend/.env (or export it in the shell).'
      );
    }
    console.error(
      'Check PostgreSQL settings: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (or DATABASE_URL).'
    );
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
