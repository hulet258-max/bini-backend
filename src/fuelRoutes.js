const crypto = require('crypto');
const FUEL_TYPES = new Set(['nafta', 'benzine']);
const MONEY_METHODS = new Set(['telebirr', 'cbe', 'cash', 'expense']);
const METER_KEYS = ['m1L', 'm1R', 'm2L', 'm2R'];
const METER_COLUMNS = {
  m1L: ['m1_l_start', 'm1_l_end'],
  m1R: ['m1_r_start', 'm1_r_end'],
  m2L: ['m2_l_start', 'm2_l_end'],
  m2R: ['m2_r_start', 'm2_r_end'],
};

function machineKeys(value, fallback = METER_KEYS) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map(String).filter((key) => METER_KEYS.includes(key)))];
}

function stationMachineKeys(station) {
  const left = METER_KEYS.filter((key) => key.endsWith('L')).slice(0, machineCount(station.left_machine_count));
  const right = METER_KEYS.filter((key) => key.endsWith('R')).slice(0, machineCount(station.right_machine_count));
  return [...left, ...right];
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dispatchNumber(value, id) {
  const supplied = String(value || '').replace(/\D/g, '');
  if (supplied) return supplied.slice(-4).padStart(4, '0');
  if (id) return String(1000 + ((id * 3571) % 9000));
  return String(crypto.randomInt(1000, 10000));
}

function plateNumber(value, id) {
  const supplied = String(value || '').replace(/\D/g, '');
  if (supplied) return `AA${supplied.slice(-5).padStart(5, '0')}`;
  const digits = id ? (id * 7919) % 100000 : crypto.randomInt(0, 100000);
  return `AA${String(digits).padStart(5, '0')}`;
}

function dateOnly(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function stationId(value) {
  return String(value || 'weldeya').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'weldeya';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith('9') && digits.length === 9) return `0${digits}`;
  return digits;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pin), salt, 64).toString('hex')}`;
}

function machineCount(value) {
  const count = Math.trunc(number(value, 2));
  return Math.min(Math.max(count, 0), 2);
}

function fuelType(value) {
  const result = String(value || 'nafta').toLowerCase();
  return FUEL_TYPES.has(result) ? result : 'nafta';
}

function loadSummary(row) {
  const hasDays = number(row.day_count) > 0;
  const sold = hasDays ? number(row.daily_sold) : number(row.sold_in_liter);
  const waste = hasDays ? number(row.daily_waste) : 0;
  const blackLitres = hasDays ? number(row.black_litres) : 0;
  const blackBirr = hasDays ? number(row.black_birr) : number(row.black);
  const expected = hasDays ? number(row.expected_revenue) : number(row.sale_amount_birr);
  const loaded = number(row.amount_in_litre);
  const openingStock = number(row.opening_stock_litres);
  const driverFuel = number(row.drivers_nafta);
  const remaining = loaded + openingStock - sold - driverFuel - waste;
  const telebirr = number(row.telebirr_total);
  const cbe = number(row.cbe_total);
  const cashRemitted = number(row.cash_total);
  const expenses = number(row.expense_total);
  const remitted = telebirr + cbe + cashRemitted;
  const cashOnHand = number(row.cash_on_hand);
  const gap = expected - remitted - expenses - cashOnHand;
  const locked = row.locked_totals && typeof row.locked_totals === 'object' ? row.locked_totals : null;
  return {
    dayCount: number(row.day_count),
    soldLitres: sold,
    remainingLitres: remaining,
    wasteLitres: waste,
    blackLitres,
    blackBirr,
    expectedRevenue: expected,
    telebirr,
    cbe,
    cashRemitted,
    totalRemitted: remitted,
    totalExpenses: expenses,
    cashOnHand,
    cashGap: gap,
    profit: expected - number(row.paid) - number(row.drivers_nafta_birr) - expenses,
    lastEntryDate: dateOnly(row.last_entry_date),
    latestDay: row.last_entry_date ? {
      date: dateOnly(row.last_entry_date),
      soldLitres: number(row.last_day_sold),
      stackLitres: number(row.last_day_stack),
      blackLitres: number(row.last_day_black),
      meters: {
        m1L: number(row.last_m1_l), m1R: number(row.last_m1_r),
        m2L: number(row.last_m2_l), m2R: number(row.last_m2_r),
      },
    } : null,
    lastRemittanceDate: dateOnly(row.last_remittance_date),
    locked,
  };
}

function mapLoad(row, mapSaleRow) {
  const activeMachines = machineKeys(row.active_machines);
  return {
    ...mapSaleRow(row),
    stationName: row.station_name || row.station_id,
    leftMachineCount: number(row.left_machine_count, 2),
    rightMachineCount: number(row.right_machine_count, 2),
    activeMachines,
    summary: loadSummary(row),
  };
}

const LOAD_SELECT = `
  SELECT s.*, st.name AS station_name, st.left_machine_count, st.right_machine_count,
    COALESCE(d.day_count, 0) AS day_count,
    COALESCE(d.daily_sold, 0) AS daily_sold,
    COALESCE(d.daily_waste, 0) AS daily_waste,
    COALESCE(d.black_litres, 0) AS black_litres,
    COALESCE(d.black_birr, 0) AS black_birr,
    COALESCE(d.expected_revenue, 0) AS expected_revenue,
    d.last_entry_date,
    ld.last_day_sold, ld.last_day_stack, ld.last_day_black,
    ld.last_m1_l, ld.last_m1_r, ld.last_m2_l, ld.last_m2_r,
    COALESCE(m.telebirr_total, 0) AS telebirr_total,
    COALESCE(m.cbe_total, 0) AS cbe_total,
    COALESCE(m.cash_total, 0) AS cash_total,
    COALESCE(m.expense_total, 0) AS expense_total,
    m.last_remittance_date,
    COALESCE(ch.cash_on_hand, 0) AS cash_on_hand
  FROM sales s
  LEFT JOIN stations st ON st.id = s.station_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS day_count, SUM(de.sold_litres) AS daily_sold,
      SUM(de.waste_litres) AS daily_waste, SUM(de.black_litres) AS black_litres,
      SUM(de.black_birr) AS black_birr, MAX(de.entry_date) AS last_entry_date,
      SUM(
        GREATEST(de.sold_litres - de.black_litres, 0) * s.sell_price_per_litre +
        CASE WHEN de.black_birr > 0 THEN de.black_birr
             ELSE de.black_litres * COALESCE(s.black_price_per_litre, s.sell_price_per_litre) END
      ) AS expected_revenue
    FROM fuel_daily_entries de WHERE de.sale_id = s.id
  ) d ON TRUE
  LEFT JOIN LATERAL (
    SELECT de.sold_litres AS last_day_sold, de.stack_litres AS last_day_stack,
      de.black_litres AS last_day_black, de.m1_l_end AS last_m1_l,
      de.m1_r_end AS last_m1_r, de.m2_l_end AS last_m2_l, de.m2_r_end AS last_m2_r
    FROM fuel_daily_entries de WHERE de.sale_id = s.id
    ORDER BY de.entry_date DESC, de.id DESC LIMIT 1
  ) ld ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      SUM(me.amount) FILTER (WHERE me.method = 'telebirr') AS telebirr_total,
      SUM(me.amount) FILTER (WHERE me.method = 'cbe') AS cbe_total,
      SUM(me.amount) FILTER (WHERE me.method = 'cash') AS cash_total,
      SUM(me.amount) FILTER (WHERE me.method = 'expense') AS expense_total,
      MAX(de.entry_date) FILTER (WHERE me.method IN ('telebirr', 'cbe', 'cash')) AS last_remittance_date
    FROM fuel_daily_entries de
    JOIN fuel_money_entries me ON me.daily_entry_id = de.id
    WHERE de.sale_id = s.id
  ) m ON TRUE
  LEFT JOIN LATERAL (
    SELECT de.cash_on_hand FROM fuel_daily_entries de
    WHERE de.sale_id = s.id ORDER BY de.entry_date DESC, de.id DESC LIMIT 1
  ) ch ON TRUE`;

async function audit(client, req, action, saleId, dailyEntryId, details = {}) {
  await client.query(
    `INSERT INTO fuel_audit_log
      (sale_id, daily_entry_id, action, actor_phone, actor_role, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [saleId || null, dailyEntryId || null, action, req.user.phone, req.user.role, details]
  );
}

async function getLoad(pool, id, mapSaleRow) {
  const result = await pool.query(`${LOAD_SELECT} WHERE s.id = $1`, [id]);
  return result.rowCount ? mapLoad(result.rows[0], mapSaleRow) : null;
}

async function ensureLoadAccess(pool, req, res, id, { mustBeOpen = false } = {}) {
  const result = await pool.query('SELECT * FROM sales WHERE id = $1', [id]);
  if (!result.rowCount) {
    res.status(404).json({ success: false, message: 'Load not found' });
    return null;
  }
  const load = result.rows[0];
  if (req.user.role !== 'admin' && load.station_id !== req.user.stationId) {
    res.status(403).json({ success: false, message: 'This load belongs to another station' });
    return null;
  }
  if (mustBeOpen && load.status !== 'open') {
    res.status(409).json({ success: false, message: 'Closed loads are locked. An admin must reopen it first.' });
    return null;
  }
  return load;
}

async function openingMeters(pool, station, fuel) {
  const daily = await pool.query(
    `SELECT de.m1_l_end, de.m1_r_end, de.m2_l_end, de.m2_r_end
     FROM fuel_daily_entries de JOIN sales s ON s.id = de.sale_id
     WHERE s.station_id=$1 AND s.fuel_type=$2
     ORDER BY de.entry_date DESC, de.id DESC LIMIT 1`,
    [station, fuel]
  );
  if (daily.rowCount) return daily.rows[0];
  const old = await pool.query(
    `SELECT m1_l AS m1_l_end, m1_r AS m1_r_end, m2_l AS m2_l_end, m2_r AS m2_r_end
     FROM sales WHERE station_id=$1 AND fuel_type=$2
     ORDER BY sale_date DESC NULLS LAST, id DESC LIMIT 1`,
    [station, fuel]
  );
  if (old.rowCount) return old.rows[0];
  const base = await pool.query(
    `SELECT m1_l AS m1_l_end, m1_r AS m1_r_end, m2_l AS m2_l_end, m2_r AS m2_r_end
     FROM meter_baseline_by_fuel WHERE station_id=$1 AND fuel_type=$2`, [station, fuel]
  );
  return base.rows[0] || { m1_l_end: 0, m1_r_end: 0, m2_l_end: 0, m2_r_end: 0 };
}

async function expectedStarts(client, load, entryDate, excludeId = null) {
  const params = [load.id, entryDate];
  let exclusion = '';
  if (excludeId) {
    params.push(excludeId);
    exclusion = 'AND id <> $3';
  }
  const prior = await client.query(
    `SELECT m1_l_end, m1_r_end, m2_l_end, m2_r_end
     FROM fuel_daily_entries WHERE sale_id=$1 AND entry_date < $2 ${exclusion}
     ORDER BY entry_date DESC, id DESC LIMIT 1`, params
  );
  const source = prior.rows[0] || {
    m1_l_end: load.m1_l, m1_r_end: load.m1_r, m2_l_end: load.m2_l, m2_r_end: load.m2_r,
  };
  return {
    m1L: number(source.m1_l_end), m1R: number(source.m1_r_end),
    m2L: number(source.m2_l_end), m2R: number(source.m2_r_end),
  };
}

function validateDay(body, starts, activeMachines = METER_KEYS) {
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
    return { error: 'A valid date is required' };
  }
  const ends = {};
  const warnings = [];
  const active = new Set(machineKeys(activeMachines));
  for (const key of METER_KEYS) {
    const rawEnd = body.meters?.[key]?.end ?? body[`${key}End`];
    // A blank reading means this machine did not sell fuel today. Carrying the
    // previous reading forward keeps the meter sequence continuous and gives
    // this machine a zero-litre contribution to today's total.
    const isBlank = rawEnd === '' || rawEnd === null || rawEnd === undefined;
    ends[key] = active.has(key) && !isBlank ? number(rawEnd, starts[key]) : starts[key];
    if (ends[key] < starts[key]) return { error: `${key} meter cannot go backwards` };
    if (ends[key] - starts[key] > 50000) warnings.push(`${key} increased by more than 50,000 L`);
  }
  const stack = Math.max(number(body.stackLitres), 0);
  const sold = METER_KEYS.reduce((sum, key) => sum + ends[key] - starts[key], 0) + stack;
  const blackLitres = Math.max(number(body.blackLitres), 0);
  if (blackLitres > sold) return { error: 'Black-market litres cannot exceed total pump litres sold' };
  return {
    starts, ends, stack, sold, blackLitres,
    blackBirr: Math.max(number(body.blackBirr), 0),
    wasteLitres: Math.max(number(body.wasteLitres), 0),
    cashOnHand: Math.max(number(body.cashOnHand), 0),
    warnings,
  };
}

function cleanMoney(body) {
  const entries = Array.isArray(body.money) ? body.money : [];
  const result = [];
  for (const entry of entries) {
    const method = String(entry.method || '').toLowerCase();
    const amount = number(entry.amount, -1);
    if (!MONEY_METHODS.has(method) || amount < 0) continue;
    if (amount === 0 && !entry.reference && !entry.reason) continue;
    result.push({ method, amount, reference: entry.reference || null, reason: entry.reason || null });
  }
  return result;
}

function mapDay(row, money = []) {
  return {
    id: row.id, loadId: row.sale_id, date: dateOnly(row.entry_date),
    meters: Object.fromEntries(METER_KEYS.map((key) => {
      const [start, end] = METER_COLUMNS[key];
      return [key, { start: number(row[start]), end: number(row[end]) }];
    })),
    stackLitres: number(row.stack_litres), soldLitres: number(row.sold_litres),
    blackLitres: number(row.black_litres), blackBirr: number(row.black_birr),
    cashOnHand: number(row.cash_on_hand), wasteLitres: number(row.waste_litres),
    notes: row.notes || '', money,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function syncSaleFromDaily(client, saleId) {
  await client.query(
    `WITH totals AS (
       SELECT
         COALESCE(SUM(de.sold_litres), 0) AS sold,
         COALESCE(SUM(de.stack_litres), 0) AS stack,
         COALESCE(SUM(
           CASE WHEN de.black_birr > 0 THEN de.black_birr
                ELSE de.black_litres * COALESCE(s.black_price_per_litre, s.sell_price_per_litre)
           END
         ), 0) AS black_birr,
         COALESCE(SUM(
           GREATEST(de.sold_litres - de.black_litres, 0) * s.sell_price_per_litre +
           CASE WHEN de.black_birr > 0 THEN de.black_birr
                ELSE de.black_litres * COALESCE(s.black_price_per_litre, s.sell_price_per_litre)
           END
         ), 0) AS sales_birr
       FROM sales s
       LEFT JOIN fuel_daily_entries de ON de.sale_id = s.id
       WHERE s.id = $1
       GROUP BY s.id
     ), expenses AS (
       SELECT COALESCE(SUM(me.amount) FILTER (WHERE me.method='expense'), 0) AS amount
       FROM fuel_daily_entries de
       LEFT JOIN fuel_money_entries me ON me.daily_entry_id = de.id
       WHERE de.sale_id = $1
     ), latest AS (
       SELECT m1_l_end,m1_r_end,m2_l_end,m2_r_end
       FROM fuel_daily_entries WHERE sale_id=$1
       ORDER BY entry_date DESC,id DESC LIMIT 1
     )
     UPDATE sales s SET
       m1_l=COALESCE(latest.m1_l_end,s.m1_l),
       m1_r=COALESCE(latest.m1_r_end,s.m1_r),
       m2_l=COALESCE(latest.m2_l_end,s.m2_l),
       m2_r=COALESCE(latest.m2_r_end,s.m2_r),
       sold_in_liter=totals.sold,
       stak=totals.stack,
       difference_in_litre=totals.sold-s.amount_in_litre-s.drivers_nafta,
       sale_amount_birr=totals.sales_birr,
       black=totals.black_birr,
       profit=totals.sales_birr-s.paid-s.drivers_nafta_birr-expenses.amount,
       diff_in_birr=totals.sales_birr-s.drivers_nafta_birr-expenses.amount,
       updated_at=NOW()
     FROM totals,expenses LEFT JOIN latest ON TRUE
     WHERE s.id=$1`,
    [saleId]
  );
}

function registerFuelRoutes(app, { getPool, mapSaleRow, requireAdmin }) {
  app.get('/api/fuel-summary', async (req, res, next) => {
    try {
      const params = [];
      let stationFilter = '';
      if (req.user.role === 'station') {
        params.push(req.user.stationId);
        stationFilter = 'AND st.id = $1';
      }
      const result = await getPool().query(
        `SELECT st.id, st.name,
          COUNT(s.id) FILTER (
            WHERE s.status = 'closed'
              AND COALESCE(s.closed_at::date, s.sale_date, s.opened_at, s.created_at::date) >= DATE_TRUNC('month', CURRENT_DATE)::date
              AND COALESCE(s.closed_at::date, s.sale_date, s.opened_at, s.created_at::date) < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::date
          )::int AS "closedBatches"
         FROM stations st
         LEFT JOIN sales s ON s.station_id = st.id
         WHERE st.active = TRUE ${stationFilter}
         GROUP BY st.id, st.name ORDER BY st.name`,
        params
      );
      res.json({
        success: true,
        data: {
          stationCount: result.rowCount,
          month: new Date().toISOString().slice(0, 7),
          stations: result.rows,
        },
      });
    } catch (error) { next(error); }
  });

  app.get('/api/stations', async (req, res, next) => {
    try {
      const params = [];
      let where = 'WHERE active = TRUE';
      if (req.user.role === 'station') {
        params.push(req.user.stationId);
        where += ' AND id = $1';
      }
      if (req.query.since) {
        params.push(req.query.since);
        where += ` AND updated_at > $${params.length}::timestamptz`;
      }
      const result = await getPool().query(
        `SELECT id, name, manager_phone AS "managerPhone",
          left_machine_count AS "leftMachineCount", right_machine_count AS "rightMachineCount", active,
          updated_at AS "updatedAt"
         FROM stations ${where} ORDER BY name`, params
      );
      res.json({ success: true, data: result.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/stations', requireAdmin, async (req, res, next) => {
    try {
      const id = stationId(req.body?.id || req.body?.name);
      const name = String(req.body?.name || '').trim();
      const phone = normalizePhone(req.body?.managerPhone);
      const pin = String(req.body?.pin || '');
      if (!name || phone.length !== 10 || pin.length < 4) {
        return res.status(400).json({ success: false, message: 'Station name, a valid 10-digit phone, and a PIN of at least 4 characters are required' });
      }
      const result = await getPool().query(
        `INSERT INTO stations (id, name, manager_phone, manager_pin_hash, left_machine_count, right_machine_count)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, name, manager_phone AS "managerPhone",
           left_machine_count AS "leftMachineCount", right_machine_count AS "rightMachineCount", active`,
        [id, name, phone, hashPin(pin), machineCount(req.body?.leftMachineCount), machineCount(req.body?.rightMachineCount)]
      );
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ success: false, message: 'That station name or manager phone is already in use' });
      next(error);
    }
  });

  app.put('/api/stations/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = stationId(req.params.id);
      const name = String(req.body?.name || '').trim();
      const phone = normalizePhone(req.body?.managerPhone);
      const pin = String(req.body?.pin || '');
      if (!name || phone.length !== 10) return res.status(400).json({ success: false, message: 'Name and a valid 10-digit manager phone are required' });
      if (pin && pin.length < 4) return res.status(400).json({ success: false, message: 'A new PIN must have at least 4 characters' });
      const result = await getPool().query(
        `UPDATE stations SET name=$1,manager_phone=$2,
          manager_pin_hash=CASE WHEN $3='' THEN manager_pin_hash ELSE $4 END,
          left_machine_count=$5,right_machine_count=$6,updated_at=NOW()
         WHERE id=$7 RETURNING id,name,manager_phone AS "managerPhone",
          left_machine_count AS "leftMachineCount",right_machine_count AS "rightMachineCount",active`,
        [name, phone, pin, pin ? hashPin(pin) : '', machineCount(req.body?.leftMachineCount), machineCount(req.body?.rightMachineCount), id]
      );
      if (!result.rowCount) return res.status(404).json({ success: false, message: 'Station not found' });
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ success: false, message: 'That manager phone is already in use' });
      next(error);
    }
  });

  app.get('/api/loads', async (req, res, next) => {
    try {
      const station = req.user.role === 'station' ? req.user.stationId : stationId(req.query.stationId);
      const fuel = fuelType(req.query.fuelType);
      const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;
      const params = [station, fuel];
      const filters = [];
      if (status) {
        params.push(status);
        filters.push(`s.status = $${params.length}`);
      }
      if (req.query.since) {
        params.push(req.query.since);
        filters.push(`s.updated_at > $${params.length}::timestamptz`);
      }
      const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';
      const result = await getPool().query(
        `${LOAD_SELECT} WHERE s.station_id=$1 AND s.fuel_type=$2 ${filterSql}
         ORDER BY (s.status='open') DESC, s.sale_date DESC NULLS LAST, s.id DESC`, params
      );
      res.json({ success: true, data: result.rows.map((r) => mapLoad(r, mapSaleRow)) });
    } catch (error) { next(error); }
  });

  app.get('/api/loads/dashboard', requireAdmin, async (_req, res, next) => {
    try {
      const result = await getPool().query(
        `${LOAD_SELECT} WHERE s.status='open' ORDER BY s.station_id, s.fuel_type`
      );
      const data = result.rows.map((r) => mapLoad(r, mapSaleRow));
      res.json({
        success: true, data,
        totals: data.reduce((a, l) => ({
          soldLitres: a.soldLitres + l.summary.soldLitres,
          remainingLitres: a.remainingLitres + l.summary.remainingLitres,
          totalRemitted: a.totalRemitted + l.summary.totalRemitted,
          cashGap: a.cashGap + l.summary.cashGap,
        }), { soldLitres: 0, remainingLitres: 0, totalRemitted: 0, cashGap: 0 }),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/loads', async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const station = req.user.role === 'station' ? req.user.stationId : stationId(body.stationId);
      const fuel = fuelType(body.fuelType);
      const openedAt = body.openedAt || body.date;
      const loaded = number(body.loadedLitres ?? body.amountInLitre, -1);
      const buyPrice = number(body.buyPricePerLitre, 180.3492);
      const sellPrice = number(body.sellPricePerLitre, 181.23);
      if (!openedAt || loaded <= 0) return res.status(400).json({ success: false, message: 'Open date and loaded litres greater than zero are required' });
      const stationExists = await client.query('SELECT 1 FROM stations WHERE id=$1 AND active=TRUE', [station]);
      if (!stationExists.rowCount) return res.status(400).json({ success: false, message: 'Choose a valid active station' });
      const stationConfig = await client.query(
        'SELECT left_machine_count,right_machine_count FROM stations WHERE id=$1 AND active=TRUE', [station]
      );
      const allowedMachines = stationMachineKeys(stationConfig.rows[0]);
      const activeMachines = machineKeys(body.activeMachines, allowedMachines).filter((key) => allowedMachines.includes(key));
      if (!activeMachines.length) return res.status(400).json({ success: false, message: 'Choose at least one machine for this dispatch' });
      const meters = await openingMeters(client, station, fuel);
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO sales (
          station_id, fuel_type, sale_date, opened_at, status, dispatch_no, truck_plate,
          amount_in_litre, paid, buy_price_per_litre, sell_price_per_litre,
          black_price_per_litre, opening_stock_litres, drivers_nafta, drivers_nafta_birr,
          m1_l, m1_r, m2_l, m2_r, notes, active_machines
        ) VALUES ($1,$2,$3,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING *`,
        [station, fuel, openedAt, dispatchNumber(body.dispatchNo), plateNumber(body.truckPlate),
          loaded, body.paid == null ? loaded * buyPrice : number(body.paid), buyPrice, sellPrice,
          number(body.blackPricePerLitre, sellPrice), Math.max(number(body.openingStockLitres), 0),
          number(body.driverFuelLitres ?? body.driversNafta),
          number(body.driverFuelLitres ?? body.driversNafta) * sellPrice,
          number(meters.m1_l_end), number(meters.m1_r_end), number(meters.m2_l_end), number(meters.m2_r_end),
          body.notes || null, activeMachines]
      );
      await audit(client, req, 'load.opened', result.rows[0].id, null, { dispatchNo: body.dispatchNo, loadedLitres: loaded });
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: await getLoad(pool, result.rows[0].id, mapSaleRow) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ success: false, message: 'Close the current open load before receiving another one for this station and fuel.' });
      next(error);
    } finally { client.release(); }
  });

  app.put('/api/loads/:id', async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const existing = await ensureLoadAccess(pool, req, res, id, { mustBeOpen: true });
      if (!existing) return;
      const body = req.body || {};
      const openedAt = body.openedAt || body.date;
      const loaded = number(body.loadedLitres ?? body.amountInLitre, -1);
      const buyPrice = number(body.buyPricePerLitre, 180.3492);
      const sellPrice = number(body.sellPricePerLitre, 181.23);
      const driverFuel = number(body.driverFuelLitres ?? body.driversNafta);
      if (!openedAt || loaded <= 0 || buyPrice <= 0 || sellPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Open date, loaded litres, buy price, and sell price must be valid' });
      }
      const stationConfig = await client.query(
        'SELECT left_machine_count,right_machine_count FROM stations WHERE id=$1 AND active=TRUE',
        [existing.station_id]
      );
      const allowedMachines = stationConfig.rowCount ? stationMachineKeys(stationConfig.rows[0]) : METER_KEYS;
      const activeMachines = machineKeys(
        body.activeMachines,
        machineKeys(existing.active_machines, allowedMachines)
      ).filter((key) => allowedMachines.includes(key));
      if (!activeMachines.length) {
        return res.status(400).json({ success: false, message: 'Choose at least one machine for this dispatch' });
      }
      await client.query('BEGIN');
      await client.query(
        `UPDATE sales SET sale_date=$1,opened_at=$1,dispatch_no=$2,truck_plate=$3,
          amount_in_litre=$4,paid=$5,buy_price_per_litre=$6,sell_price_per_litre=$7,
          black_price_per_litre=$8,opening_stock_litres=$9,drivers_nafta=$10,
          drivers_nafta_birr=$11,notes=$12,active_machines=$13,updated_at=NOW() WHERE id=$14`,
        [openedAt, dispatchNumber(body.dispatchNo, id), plateNumber(body.truckPlate, id), loaded,
          body.paid == null ? loaded * buyPrice : number(body.paid), buyPrice, sellPrice,
          number(body.blackPricePerLitre, sellPrice), Math.max(number(body.openingStockLitres), 0),
          driverFuel, driverFuel * sellPrice, body.notes || null, activeMachines, id]
      );
      await audit(client, req, 'load.updated', id, null, { loadedLitres: loaded, dispatchNo: body.dispatchNo || null, activeMachines });
      await client.query('COMMIT');
      res.json({ success: true, data: await getLoad(pool, id, mapSaleRow) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  app.get('/api/loads/:id/days', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const load = await ensureLoadAccess(getPool(), req, res, id);
      if (!load) return;
      const days = await getPool().query('SELECT * FROM fuel_daily_entries WHERE sale_id=$1 ORDER BY entry_date, id', [id]);
      const money = await getPool().query(
        `SELECT me.* FROM fuel_money_entries me JOIN fuel_daily_entries de ON de.id=me.daily_entry_id
         WHERE de.sale_id=$1 ORDER BY me.id`, [id]
      );
      const byDay = new Map();
      for (const entry of money.rows) {
        if (!byDay.has(entry.daily_entry_id)) byDay.set(entry.daily_entry_id, []);
        byDay.get(entry.daily_entry_id).push({
          id: entry.id, method: entry.method, amount: number(entry.amount),
          reference: entry.reference || '', reason: entry.reason || '',
        });
      }
      const previous = days.rowCount
        ? mapDay(days.rows[days.rows.length - 1]).meters
        : Object.fromEntries(METER_KEYS.map((key) => [key, { start: number(load[METER_COLUMNS[key][0].replace('_start', '')]), end: number(load[METER_COLUMNS[key][0].replace('_start', '')]) }]));
      res.json({ success: true, data: days.rows.map((d) => mapDay(d, byDay.get(d.id) || [])), nextMeters: previous });
    } catch (error) { next(error); }
  });

  app.post('/api/loads/:id/money', async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const load = await ensureLoadAccess(pool, req, res, id, { mustBeOpen: true });
      if (!load) return;
      const body = req.body || {};
      const date = String(body.date || '');
      const method = String(body.method || '').toLowerCase();
      const amount = number(body.amount, -1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !MONEY_METHODS.has(method) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Valid date, category, and amount greater than zero are required' });
      }
      if (date < dateOnly(load.opened_at || load.sale_date)) {
        return res.status(400).json({ success: false, message: 'Entry date cannot be before the load open date' });
      }
      await client.query('BEGIN');
      let daily = await client.query(
        `SELECT id FROM fuel_daily_entries WHERE sale_id=$1 AND entry_date=$2`, [id, date]
      );
      if (!daily.rowCount) {
        const latest = await client.query(
          `SELECT MAX(entry_date) AS date FROM fuel_daily_entries WHERE sale_id=$1`, [id]
        );
        if (latest.rows[0].date && date < dateOnly(latest.rows[0].date)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, message: 'Add a Daily litres row for this earlier date before adding money' });
        }
        const starts = await expectedStarts(client, load, date);
        daily = await client.query(
          `INSERT INTO fuel_daily_entries (
            sale_id,entry_date,m1_l_start,m1_l_end,m1_r_start,m1_r_end,
            m2_l_start,m2_l_end,m2_r_start,m2_r_end,created_by
           ) VALUES ($1,$2,$3,$3,$4,$4,$5,$5,$6,$6,$7) RETURNING id`,
          [id, date, starts.m1L, starts.m1R, starts.m2L, starts.m2R, req.user.phone]
        );
      }
      const result = await client.query(
        `INSERT INTO fuel_money_entries (daily_entry_id,method,amount,reference,reason)
         VALUES ($1,$2,$3,$4,$5) RETURNING id,method,amount,reference,reason`,
        [daily.rows[0].id, method, amount, body.reference || null, body.reason || null]
      );
      await syncSaleFromDaily(client, id);
      await audit(client, req, method === 'expense' ? 'expense.created' : 'remittance.created', id, daily.rows[0].id,
        { date, method, amount, entryId: result.rows[0].id });
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  app.put('/api/loads/:id/money/:moneyId', async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const moneyId = Number(req.params.moneyId);
      const load = await ensureLoadAccess(pool, req, res, id, { mustBeOpen: true });
      if (!load) return;
      const body = req.body || {};
      const method = String(body.method || '').toLowerCase();
      const amount = number(body.amount, -1);
      const existing = await client.query(
        `SELECT me.id,me.daily_entry_id,de.entry_date FROM fuel_money_entries me
         JOIN fuel_daily_entries de ON de.id=me.daily_entry_id
         WHERE me.id=$1 AND de.sale_id=$2`, [moneyId, id]
      );
      if (!existing.rowCount) return res.status(404).json({ success: false, message: 'Money entry not found' });
      if (dateOnly(body.date) !== dateOnly(existing.rows[0].entry_date)) {
        return res.status(400).json({ success: false, message: 'The date of an existing money entry cannot be changed' });
      }
      if (!MONEY_METHODS.has(method) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Valid category and amount greater than zero are required' });
      }
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE fuel_money_entries SET method=$1,amount=$2,reference=$3,reason=$4
         WHERE id=$5 RETURNING id,method,amount,reference,reason`,
        [method, amount, body.reference || null, body.reason || null, moneyId]
      );
      await syncSaleFromDaily(client, id);
      await audit(client, req, method === 'expense' ? 'expense.updated' : 'remittance.updated',
        id, existing.rows[0].daily_entry_id, { date: body.date, method, amount, entryId: moneyId });
      await client.query('COMMIT');
      res.json({ success: true, data: { ...result.rows[0], date: dateOnly(existing.rows[0].entry_date) } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  async function saveDay(req, res, next, existingId = null) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const load = await ensureLoadAccess(pool, req, res, id, { mustBeOpen: true });
      if (!load) return;
      const body = req.body || {};
      if (dateOnly(body.date) < dateOnly(load.opened_at || load.sale_date)) {
        return res.status(400).json({ success: false, message: 'Daily entry cannot be before the load open date' });
      }
      let existingDay = null;
      if (existingId) {
        const existingResult = await client.query(
          'SELECT * FROM fuel_daily_entries WHERE id=$1 AND sale_id=$2', [existingId, id]
        );
        if (!existingResult.rowCount) return res.status(404).json({ success: false, message: 'Daily entry not found' });
        existingDay = existingResult.rows[0];
        if (dateOnly(body.date) !== dateOnly(existingDay.entry_date)) {
          return res.status(400).json({ success: false, message: 'The date of an existing daily entry cannot be changed' });
        }
      } else {
        const latest = await client.query('SELECT MAX(entry_date) AS d FROM fuel_daily_entries WHERE sale_id=$1', [id]);
        if (latest.rows[0].d && dateOnly(body.date) <= dateOnly(latest.rows[0].d)) {
          return res.status(409).json({ success: false, message: 'Add days in date order. Edit the existing date instead.' });
        }
      }
      const starts = await expectedStarts(client, load, body.date, existingId);
      const values = validateDay(body, starts, machineKeys(load.active_machines));
      if (values.error) return res.status(400).json({ success: false, message: values.error });
      const money = cleanMoney(body);
      await client.query('BEGIN');
      let result;
      const args = [body.date,
        starts.m1L, values.ends.m1L, starts.m1R, values.ends.m1R,
        starts.m2L, values.ends.m2L, starts.m2R, values.ends.m2R,
        values.stack, values.sold, values.blackLitres, values.blackBirr,
        values.cashOnHand, values.wasteLitres, body.notes || null, req.user.phone];
      if (existingId) {
        result = await client.query(
          `UPDATE fuel_daily_entries SET entry_date=$1,
            m1_l_start=$2,m1_l_end=$3,m1_r_start=$4,m1_r_end=$5,
            m2_l_start=$6,m2_l_end=$7,m2_r_start=$8,m2_r_end=$9,
            stack_litres=$10,sold_litres=$11,black_litres=$12,black_birr=$13,
            cash_on_hand=$14,waste_litres=$15,notes=$16,updated_at=NOW()
           WHERE id=$17 AND sale_id=$18 RETURNING *`, [...args.slice(0, 16), existingId, id]
        );
        if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Daily entry not found' }); }
        const laterDays = await client.query(
          'SELECT * FROM fuel_daily_entries WHERE sale_id=$1 AND entry_date>$2 ORDER BY entry_date,id',
          [id, existingDay.entry_date]
        );
        let rollingStarts = values.ends;
        for (const laterRow of laterDays.rows) {
          const laterDay = mapDay(laterRow);
          const recalculated = validateDay(laterDay, rollingStarts, machineKeys(load.active_machines));
          if (recalculated.error) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              success: false,
              message: `This change conflicts with ${laterDay.date}: ${recalculated.error}`,
            });
          }
          await client.query(
            `UPDATE fuel_daily_entries SET
              m1_l_start=$1,m1_l_end=$2,m1_r_start=$3,m1_r_end=$4,
              m2_l_start=$5,m2_l_end=$6,m2_r_start=$7,m2_r_end=$8,
              sold_litres=$9,updated_at=NOW() WHERE id=$10`,
            [rollingStarts.m1L, recalculated.ends.m1L, rollingStarts.m1R, recalculated.ends.m1R,
              rollingStarts.m2L, recalculated.ends.m2L, rollingStarts.m2R, recalculated.ends.m2R,
              recalculated.sold, laterRow.id]
          );
          rollingStarts = recalculated.ends;
        }
        await client.query('DELETE FROM fuel_money_entries WHERE daily_entry_id=$1', [existingId]);
      } else {
        result = await client.query(
          `INSERT INTO fuel_daily_entries (entry_date,m1_l_start,m1_l_end,m1_r_start,m1_r_end,
            m2_l_start,m2_l_end,m2_r_start,m2_r_end,stack_litres,sold_litres,
            black_litres,black_birr,cash_on_hand,waste_litres,notes,created_by,sale_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [...args, id]
        );
      }
      const dayId = result.rows[0].id;
      for (const entry of money) {
        await client.query(
          `INSERT INTO fuel_money_entries (daily_entry_id,method,amount,reference,reason) VALUES ($1,$2,$3,$4,$5)`,
          [dayId, entry.method, entry.amount, entry.reference, entry.reason]
        );
      }
      await syncSaleFromDaily(client, id);
      await audit(client, req, existingId ? 'day.updated' : 'day.created', id, dayId,
        { date: body.date, soldLitres: values.sold, warnings: values.warnings });
      await client.query('COMMIT');
      res.status(existingId ? 200 : 201).json({
        success: true, data: mapDay(result.rows[0], money), warnings: values.warnings,
        load: await getLoad(pool, id, mapSaleRow),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ success: false, message: 'That date already has a daily entry' });
      next(error);
    } finally { client.release(); }
  }

  app.post('/api/loads/:id/days', (req, res, next) => saveDay(req, res, next));
  app.put('/api/loads/:id/days/:dayId', (req, res, next) => saveDay(req, res, next, Number(req.params.dayId)));

  app.post('/api/loads/:id/close', async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const raw = await ensureLoadAccess(pool, req, res, id, { mustBeOpen: true });
      if (!raw) return;
      const load = await getLoad(pool, id, mapSaleRow);
      const reason = String(req.body?.varianceReason || '').trim();
      if (Math.abs(load.summary.remainingLitres) > 20 && !reason) {
        return res.status(400).json({ success: false, message: `Remaining stock is ${load.summary.remainingLitres.toFixed(2)} L. Add a variance reason before closing.` });
      }
      await client.query('BEGIN');
      const locked = { ...load.summary, lockedAt: new Date().toISOString() };
      await client.query(
        `UPDATE sales SET status='closed',closed_at=NOW(),close_variance_reason=$1,locked_totals=$2,
          sold_in_liter=$3,sale_amount_birr=$4,profit=$5,difference_in_litre=$6,
          m1_l=COALESCE((SELECT m1_l_end FROM fuel_daily_entries WHERE sale_id=$7 ORDER BY entry_date DESC LIMIT 1),m1_l),
          m1_r=COALESCE((SELECT m1_r_end FROM fuel_daily_entries WHERE sale_id=$7 ORDER BY entry_date DESC LIMIT 1),m1_r),
          m2_l=COALESCE((SELECT m2_l_end FROM fuel_daily_entries WHERE sale_id=$7 ORDER BY entry_date DESC LIMIT 1),m2_l),
          m2_r=COALESCE((SELECT m2_r_end FROM fuel_daily_entries WHERE sale_id=$7 ORDER BY entry_date DESC LIMIT 1),m2_r),
          updated_at=NOW() WHERE id=$7`,
        [reason || null, JSON.stringify(locked), load.summary.soldLitres, load.summary.expectedRevenue,
          load.summary.profit,
          load.summary.soldLitres - load.amountInLitre - load.driversNafta,
          id]
      );
      await audit(client, req, 'load.closed', id, null, { varianceReason: reason, totals: locked });
      await client.query('COMMIT');
      res.json({ success: true, data: await getLoad(pool, id, mapSaleRow) });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
    finally { client.release(); }
  });

  app.post('/api/loads/:id/reopen', requireAdmin, async (req, res, next) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const load = await ensureLoadAccess(pool, req, res, id);
      if (!load) return;
      await client.query('BEGIN');
      await client.query(`UPDATE sales SET status='open',closed_at=NULL,locked_totals=NULL,updated_at=NOW() WHERE id=$1`, [id]);
      await audit(client, req, 'load.reopened', id, null, { reason: req.body?.reason || null });
      await client.query('COMMIT');
      res.json({ success: true, data: await getLoad(pool, id, mapSaleRow) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ success: false, message: 'Another load is already open for this station and fuel.' });
      next(error);
    } finally { client.release(); }
  });

  app.get('/api/loads/:id/audit', requireAdmin, async (req, res, next) => {
    try {
      const result = await getPool().query(
        `SELECT id,action,actor_phone,actor_role,details,created_at FROM fuel_audit_log
         WHERE sale_id=$1 ORDER BY created_at DESC`, [Number(req.params.id)]
      );
      res.json({ success: true, data: result.rows });
    } catch (error) { next(error); }
  });

  app.get('/api/reports/fuel', async (req, res, next) => {
    try {
      const params = [];
      const filters = [];
      if (req.user.role === 'station') { params.push(req.user.stationId); filters.push(`s.station_id=$${params.length}`); }
      else if (req.query.stationId) { params.push(stationId(req.query.stationId)); filters.push(`s.station_id=$${params.length}`); }
      if (req.query.fuelType) { params.push(fuelType(req.query.fuelType)); filters.push(`s.fuel_type=$${params.length}`); }
      if (req.query.from) { params.push(req.query.from); filters.push(`de.entry_date >= $${params.length}`); }
      if (req.query.to) { params.push(req.query.to); filters.push(`de.entry_date <= $${params.length}`); }
      const result = await getPool().query(
        `SELECT s.station_id, st.name AS station_name, s.fuel_type,
          COUNT(DISTINCT de.id)::int AS days, COALESCE(SUM(de.sold_litres),0) AS sold_litres,
          COALESCE(SUM(de.black_litres),0) AS black_litres, COALESCE(SUM(de.black_birr),0) AS black_birr,
          COALESCE(SUM(dm.remitted),0) AS remitted, COALESCE(SUM(dm.expenses),0) AS expenses
         FROM sales s JOIN stations st ON st.id=s.station_id
         JOIN fuel_daily_entries de ON de.sale_id=s.id
         LEFT JOIN LATERAL (
           SELECT SUM(me.amount) FILTER (WHERE me.method IN ('telebirr','cbe','cash')) AS remitted,
             SUM(me.amount) FILTER (WHERE me.method='expense') AS expenses
           FROM fuel_money_entries me WHERE me.daily_entry_id=de.id
         ) dm ON TRUE
         ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
         GROUP BY s.station_id,st.name,s.fuel_type ORDER BY st.name,s.fuel_type`, params
      );
      res.json({ success: true, data: result.rows.map((r) => ({
        stationId: r.station_id, stationName: r.station_name, fuelType: r.fuel_type,
        days: number(r.days), soldLitres: number(r.sold_litres), blackLitres: number(r.black_litres),
        blackBirr: number(r.black_birr), remitted: number(r.remitted), expenses: number(r.expenses),
      })) });
    } catch (error) { next(error); }
  });
}

module.exports = { registerFuelRoutes, loadSummary, validateDay, syncSaleFromDaily };
