const path = require('path');
const crypto = require('crypto');
const { Client, Pool } = require('pg');
// Always load backend/.env (works even when cwd is backend/src)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { STATION_SEEDS, SEED_VERSION } = require('./weldyaSeed');
const {
  TRANSPORT_SEED_VERSION,
  COMBINED_ROWS,
} = require('./transportSeed');

/**
 * Connection config from discrete PG* vars or a single DATABASE_URL
 * (common on EasyPanel / managed hosts).
 */
function getConnectionConfig(databaseOverride) {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    if (databaseOverride) {
      url.pathname = `/${databaseOverride}`;
    }
    return {
      connectionString: url.toString(),
      // Internal EasyPanel / Docker networks are usually plain TCP.
      // Set PGSSL=true if your provider requires TLS.
      ssl:
        process.env.PGSSL === 'true' || process.env.PGSSL === '1'
          ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    };
  }

  const {
    PGHOST = 'localhost',
    PGPORT = 5432,
    PGUSER = 'postgres',
    PGPASSWORD,
    PGDATABASE = 'bini',
  } = process.env;

  // pg SCRAM requires a non-empty string password (undefined/null/'' all fail)
  const password =
    PGPASSWORD === undefined || PGPASSWORD === null ? '' : String(PGPASSWORD);

  return {
    host: PGHOST,
    port: Number(PGPORT),
    user: PGUSER,
    password,
    database: databaseOverride || PGDATABASE,
    ssl:
      process.env.PGSSL === 'true' || process.env.PGSSL === '1'
        ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined,
  };
}

function getTargetDatabaseName() {
  if (process.env.DATABASE_URL) {
    try {
      const path = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
      return path || process.env.PGDATABASE || 'bini';
    } catch {
      return process.env.PGDATABASE || 'bini';
    }
  }
  return process.env.PGDATABASE || 'bini';
}

let pool = null;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith('9') && digits.length === 9) return `0${digits}`;
  return digits;
}

async function ensureDatabaseExists(pgDatabase) {
  // Skip auto-create when using DATABASE_URL or when disabled
  // (EasyPanel Postgres already provisions the database).
  if (process.env.DATABASE_URL || process.env.PG_SKIP_CREATE === 'true') {
    return;
  }

  const adminClient = new Client(getConnectionConfig('postgres'));

  try {
    await adminClient.connect();
    const check = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [pgDatabase]
    );

    if (check.rowCount === 0) {
      const safeName = pgDatabase.replace(/"/g, '""');
      await adminClient.query(`CREATE DATABASE "${safeName}"`);
      console.log(`Database "${pgDatabase}" created.`);
    } else {
      console.log(`Database "${pgDatabase}" already exists.`);
    }
  } catch (err) {
    // Managed Postgres often denies CREATE DATABASE / connect to "postgres".
    // Continue and try the target database directly.
    console.warn(
      `Could not ensure database exists (${err.message}). Connecting to "${pgDatabase}" directly.`
    );
  } finally {
    try {
      await adminClient.end();
    } catch {
      // ignore
    }
  }
}

async function initDatabase() {
  const pgDatabase = getTargetDatabaseName();

  await ensureDatabaseExists(pgDatabase);

  pool = new Pool(getConnectionConfig(pgDatabase));

  // Drop old simple sales table if present (schema upgrade from first version)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'amount_sold'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'sale_amount_birr'
      ) THEN
        DROP TABLE sales;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meter_baseline (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      m1_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      station_id TEXT NOT NULL DEFAULT 'weldeya',
      fuel_type TEXT NOT NULL DEFAULT 'nafta' CHECK (fuel_type IN ('nafta', 'benzine')),
      sale_date DATE,
      dispatch_no TEXT,
      amount_in_litre NUMERIC(14, 4) NOT NULL DEFAULT 0,
      paid NUMERIC(16, 4) NOT NULL DEFAULT 0,
      m1_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      sold_in_liter NUMERIC(14, 4) NOT NULL DEFAULT 0,
      stak NUMERIC(14, 4) NOT NULL DEFAULT 0,
      difference_in_litre NUMERIC(14, 4) NOT NULL DEFAULT 0,
      drivers_nafta NUMERIC(14, 4) NOT NULL DEFAULT 0,
      sale_amount_birr NUMERIC(16, 4) NOT NULL DEFAULT 0,
      adj_n NUMERIC(16, 4) NOT NULL DEFAULT 0,
      adj_o NUMERIC(16, 4) NOT NULL DEFAULT 0,
      adj_p NUMERIC(16, 4) NOT NULL DEFAULT 0,
      adj_q NUMERIC(16, 4) NOT NULL DEFAULT 0,
      drivers_nafta_birr NUMERIC(16, 4) NOT NULL DEFAULT 0,
      black NUMERIC(16, 4) NOT NULL DEFAULT 0,
      profit NUMERIC(16, 4) NOT NULL DEFAULT 0,
      diff_in_birr NUMERIC(16, 4) NOT NULL DEFAULT 0,
      buy_price_per_litre NUMERIC(16, 6) NOT NULL DEFAULT 180.3492,
      sell_price_per_litre NUMERIC(16, 6) NOT NULL DEFAULT 181.23,
      qen TEXT,
      telebirr TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migrate older DBs created before fuel_type / station / unit prices
  await pool.query(`
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS station_id TEXT NOT NULL DEFAULT 'weldeya';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS fuel_type TEXT NOT NULL DEFAULT 'nafta';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS buy_price_per_litre NUMERIC(16, 6) NOT NULL DEFAULT 180.3492;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sell_price_per_litre NUMERIC(16, 6) NOT NULL DEFAULT 181.23;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'closed';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS opened_at DATE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS opening_stock_litres NUMERIC(14, 4) NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS black_price_per_litre NUMERIC(16, 6);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS truck_plate TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS close_variance_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS locked_totals JSONB;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS active_machines TEXT[] NOT NULL DEFAULT ARRAY['m1L','m1R','m2L','m2R']::TEXT[];
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Existing spreadsheet rows are historical loads. New loads are explicitly opened.
  await pool.query(`
    UPDATE sales SET opened_at = COALESCE(opened_at, sale_date);
    UPDATE sales SET status = 'closed' WHERE status NOT IN ('open', 'closed');
    CREATE UNIQUE INDEX IF NOT EXISTS sales_one_open_load_idx
      ON sales (station_id, fuel_type) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS sales_station_fuel_status_idx
      ON sales (station_id, fuel_type, status, sale_date DESC);
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_status_check') THEN
        ALTER TABLE sales ADD CONSTRAINT sales_status_check CHECK (status IN ('open', 'closed'));
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meter_baseline_by_fuel (
      station_id TEXT NOT NULL DEFAULT 'weldeya',
      fuel_type TEXT NOT NULL CHECK (fuel_type IN ('nafta', 'benzine')),
      m1_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_l NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_r NUMERIC(14, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (station_id, fuel_type)
    )
  `);
  await pool.query(`
    ALTER TABLE meter_baseline_by_fuel
      ADD COLUMN IF NOT EXISTS station_id TEXT NOT NULL DEFAULT 'weldeya';
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'meter_baseline_by_fuel'::regclass
          AND conname = 'meter_baseline_by_fuel_pkey'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (fuel_type)'
      ) THEN
        ALTER TABLE meter_baseline_by_fuel DROP CONSTRAINT meter_baseline_by_fuel_pkey;
        ALTER TABLE meter_baseline_by_fuel
          ADD CONSTRAINT meter_baseline_by_fuel_pkey PRIMARY KEY (station_id, fuel_type);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS money_transfers (
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 1),
      transfer_date DATE,
      amount NUMERIC(16, 2),
      amount_end NUMERIC(16, 2),
      machine TEXT,
      reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (sale_id, method, position)
    )
  `);

  // Relax older CHECK constraints so Telebirr/CBE/daily can grow freely
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 'money_transfers' AND c.contype = 'c'
      LOOP
        EXECUTE format('ALTER TABLE money_transfers DROP CONSTRAINT IF EXISTS %I', r.conname);
      END LOOP;
      ALTER TABLE money_transfers
        ADD CONSTRAINT money_transfers_position_check CHECK (position >= 1);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE money_transfers ADD COLUMN IF NOT EXISTS amount_end NUMERIC(16, 2);
    ALTER TABLE money_transfers ADD COLUMN IF NOT EXISTS machine TEXT;
    ALTER TABLE money_transfers ADD COLUMN IF NOT EXISTS reason TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Fuel domain v2: DB-backed stations, days under a load, money rows, and audit history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      manager_phone TEXT,
      manager_pin_hash TEXT,
      left_machine_count INTEGER NOT NULL DEFAULT 2,
      right_machine_count INTEGER NOT NULL DEFAULT 2,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS manager_phone TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS manager_pin_hash TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS left_machine_count INTEGER NOT NULL DEFAULT 2;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS right_machine_count INTEGER NOT NULL DEFAULT 2;
    CREATE UNIQUE INDEX IF NOT EXISTS stations_manager_phone_idx
      ON stations (manager_phone) WHERE manager_phone IS NOT NULL;
    INSERT INTO stations (id, name) VALUES ('weldeya', 'Weldeya')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO stations (id, name)
      SELECT DISTINCT station_id,
        INITCAP(REPLACE(REPLACE(station_id, '-', ' '), '_', ' '))
      FROM sales
      ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fuel_daily_entries (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      entry_date DATE NOT NULL,
      m1_l_start NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_l_end NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_r_start NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m1_r_end NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_l_start NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_l_end NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_r_start NUMERIC(14, 2) NOT NULL DEFAULT 0,
      m2_r_end NUMERIC(14, 2) NOT NULL DEFAULT 0,
      stack_litres NUMERIC(14, 4) NOT NULL DEFAULT 0,
      sold_litres NUMERIC(14, 4) NOT NULL DEFAULT 0,
      black_litres NUMERIC(14, 4) NOT NULL DEFAULT 0,
      black_birr NUMERIC(16, 2) NOT NULL DEFAULT 0,
      cash_on_hand NUMERIC(16, 2) NOT NULL DEFAULT 0,
      waste_litres NUMERIC(14, 4) NOT NULL DEFAULT 0,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sale_id, entry_date)
    );
    CREATE INDEX IF NOT EXISTS fuel_daily_entries_sale_date_idx
      ON fuel_daily_entries (sale_id, entry_date);

    CREATE TABLE IF NOT EXISTS fuel_money_entries (
      id SERIAL PRIMARY KEY,
      daily_entry_id INTEGER NOT NULL REFERENCES fuel_daily_entries(id) ON DELETE CASCADE,
      method TEXT NOT NULL CHECK (method IN ('telebirr', 'cbe', 'cash', 'expense')),
      amount NUMERIC(16, 2) NOT NULL CHECK (amount >= 0),
      reference TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS fuel_money_entries_daily_idx
      ON fuel_money_entries (daily_entry_id, method);

    CREATE TABLE IF NOT EXISTS fuel_audit_log (
      id BIGSERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      daily_entry_id INTEGER REFERENCES fuel_daily_entries(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      actor_phone TEXT,
      actor_role TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS fuel_audit_log_sale_idx
      ON fuel_audit_log (sale_id, created_at DESC);
  `);
  // One-time, lossless promotion of legacy daily/transfer rows into the new model.
  const fuelMigration = await pool.query(
    `SELECT value FROM app_meta WHERE key = 'fuel_domain_version'`
  );
  if (!fuelMigration.rowCount || fuelMigration.rows[0].value !== '2') {
    await pool.query(`
      INSERT INTO fuel_daily_entries (
        sale_id, entry_date,
        m1_l_start, m1_l_end, m1_r_start, m1_r_end,
        m2_l_start, m2_l_end, m2_r_start, m2_r_end,
        sold_litres, notes, created_by
      )
      SELECT mt.sale_id, mt.transfer_date,
        COALESCE(MAX(mt.amount) FILTER (WHERE LOWER(mt.machine) = 'm1l'), 0),
        COALESCE(MAX(mt.amount_end) FILTER (WHERE LOWER(mt.machine) = 'm1l'), 0),
        COALESCE(MAX(mt.amount) FILTER (WHERE LOWER(mt.machine) = 'm1r'), 0),
        COALESCE(MAX(mt.amount_end) FILTER (WHERE LOWER(mt.machine) = 'm1r'), 0),
        COALESCE(MAX(mt.amount) FILTER (WHERE LOWER(mt.machine) = 'm2l'), 0),
        COALESCE(MAX(mt.amount_end) FILTER (WHERE LOWER(mt.machine) = 'm2l'), 0),
        COALESCE(MAX(mt.amount) FILTER (WHERE LOWER(mt.machine) = 'm2r'), 0),
        COALESCE(MAX(mt.amount_end) FILTER (WHERE LOWER(mt.machine) = 'm2r'), 0),
        COALESCE(SUM(GREATEST(COALESCE(mt.amount_end, 0) - COALESCE(mt.amount, 0), 0)), 0),
        'Migrated from legacy Daily entries', 'migration'
      FROM money_transfers mt
      WHERE mt.method IN ('daily', 'daily_start', 'daily_end')
        AND mt.transfer_date IS NOT NULL
      GROUP BY mt.sale_id, mt.transfer_date
      ON CONFLICT (sale_id, entry_date) DO NOTHING;

      INSERT INTO fuel_daily_entries (sale_id, entry_date, notes, created_by)
      SELECT DISTINCT mt.sale_id, mt.transfer_date, 'Migrated financial entries', 'migration'
      FROM money_transfers mt
      WHERE mt.method IN ('telebirr', 'cbe', 'expense') AND mt.transfer_date IS NOT NULL
      ON CONFLICT (sale_id, entry_date) DO NOTHING;

      INSERT INTO fuel_money_entries (daily_entry_id, method, amount, reason)
      SELECT d.id, CASE WHEN mt.method = 'expense' THEN 'expense' ELSE mt.method END,
        mt.amount, mt.reason
      FROM money_transfers mt
      JOIN fuel_daily_entries d
        ON d.sale_id = mt.sale_id AND d.entry_date = mt.transfer_date
      WHERE mt.method IN ('telebirr', 'cbe', 'expense') AND mt.amount IS NOT NULL;

      INSERT INTO app_meta (key, value) VALUES ('fuel_domain_version', '2')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    `);
  }

  // Replace all fuel-station data with exact WELDYA.xlsx + ARSI.xlsx content.
  const seedMeta = await pool.query(`SELECT value FROM app_meta WHERE key = 'seed_version'`);
  const currentSeed = seedMeta.rowCount ? seedMeta.rows[0].value : null;
  if (currentSeed !== SEED_VERSION) {
    console.log(`Reseeding fuel stations (${currentSeed || 'none'} -> ${SEED_VERSION})...`);
    const seedClient = await pool.connect();
    try {
      await seedClient.query('BEGIN');
      await seedClient.query(`TRUNCATE TABLE
        fuel_audit_log, fuel_money_entries, fuel_daily_entries,
        money_transfers, sales RESTART IDENTITY CASCADE`);
      await seedClient.query('DELETE FROM stations');
      await seedClient.query('DELETE FROM meter_baseline');
      await seedClient.query('DELETE FROM meter_baseline_by_fuel');

    async function insertSaleRows(stationId, fuelType, rows) {
      for (const r of rows) {
        await seedClient.query(
          `INSERT INTO sales (
            station_id, fuel_type, sale_date, dispatch_no,
            amount_in_litre, paid, m1_l, m1_r, m2_l, m2_r,
            sold_in_liter, stak, difference_in_litre, drivers_nafta,
            sale_amount_birr, drivers_nafta_birr, black, profit, diff_in_birr,
            buy_price_per_litre, sell_price_per_litre
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
          )`,
          [
            stationId,
            fuelType,
            r.sale_date,
            r.dispatch_no,
            r.amount_in_litre,
            r.paid,
            r.m1_l,
            r.m1_r,
            r.m2_l,
            r.m2_r,
            r.sold_in_liter,
            r.stak,
            r.difference_in_litre,
            r.drivers_nafta,
            r.sale_amount_birr,
            r.drivers_nafta_birr,
            r.black,
            r.profit,
            r.diff_in_birr,
            r.buy_price_per_litre,
            r.sell_price_per_litre,
          ]
        );
      }
    }

    for (const station of STATION_SEEDS) {
      await seedClient.query(
        `INSERT INTO stations (id, name, left_machine_count, right_machine_count)
         VALUES ($1, $2, $3, $4)`,
        [station.id, station.name, station.leftMachineCount, station.rightMachineCount]
      );
      for (const [fuelType, fuel] of Object.entries(station.fuels)) {
        const b = fuel.baseline;
        await seedClient.query(
          `INSERT INTO meter_baseline_by_fuel
            (station_id, fuel_type, m1_l, m1_r, m2_l, m2_r)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [station.id, fuelType, b.m1L, b.m1R, b.m2L, b.m2R]
        );
        await insertSaleRows(station.id, fuelType, fuel.rows);
      }
    }

    const legacy = STATION_SEEDS.find((station) => station.id === 'weldeya').fuels.nafta.baseline;
    await seedClient.query(
      `INSERT INTO meter_baseline (id, m1_l, m1_r, m2_l, m2_r)
       VALUES (1,$1,$2,$3,$4)`,
      [legacy.m1L, legacy.m1R, legacy.m2L, legacy.m2R]
    );

    await seedClient.query(
      `INSERT INTO app_meta (key, value) VALUES ('seed_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [SEED_VERSION]
    );
      await seedClient.query('COMMIT');
      console.log(`Fuel seed loaded: ${STATION_SEEDS.length} stations.`);
    } catch (error) {
      await seedClient.query('ROLLBACK');
      throw error;
    } finally {
      seedClient.release();
    }
  }

  const defaultStationPhone = normalizePhone(process.env.MOCK_STATION_PHONE || '0922222222');
  const stationAccount = await pool.query(
    `SELECT manager_phone, manager_pin_hash FROM stations WHERE id='weldeya'`
  );
  if (stationAccount.rowCount && (!stationAccount.rows[0].manager_phone || !stationAccount.rows[0].manager_pin_hash)) {
    await pool.query(
      `UPDATE stations SET manager_phone=$1, manager_pin_hash=$2, updated_at=NOW() WHERE id='weldeya'`,
      [defaultStationPhone, hashPin(process.env.APP_PIN || '1234')]
    );
  }

  // Transportation tables (tele.xlsx + loaded .xlsx)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transports (
      id SERIAL PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'tele',
      row_no INTEGER,
      plate TEXT,
      vehicle_type TEXT,
      driver_name TEXT,
      driver_phone TEXT,
      destination TEXT,
      cargo_type TEXT,
      quantity NUMERIC(14, 4),
      unit_price NUMERIC(16, 6),
      km NUMERIC(14, 4),
      total_price NUMERIC(16, 4),
      rent NUMERIC(16, 4),
      deposit NUMERIC(16, 4),
      remaining NUMERIC(16, 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS transports_org_id_idx ON transports (org_id);
  `);

  const transportSeedMeta = await pool.query(
    `SELECT value FROM app_meta WHERE key = 'transport_seed_version'`
  );
  const currentTransportSeed = transportSeedMeta.rowCount
    ? transportSeedMeta.rows[0].value
    : null;

  if (currentTransportSeed !== TRANSPORT_SEED_VERSION) {
    console.log(
      `Reseeding transports (${currentTransportSeed || 'none'} → ${TRANSPORT_SEED_VERSION})…`
    );
    await pool.query('TRUNCATE TABLE transports RESTART IDENTITY CASCADE');

    async function insertTransportRows(orgId, rows) {
      for (const r of rows) {
        await pool.query(
          `INSERT INTO transports (
            org_id, row_no, plate, vehicle_type, driver_name, driver_phone,
            destination, cargo_type, quantity, unit_price, km, total_price,
            rent, deposit, remaining
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
          )`,
          [
            orgId,
            r.rowNo ?? null,
            r.plate ?? null,
            r.vehicleType ?? null,
            r.driverName ?? null,
            r.driverPhone ?? null,
            r.destination ?? null,
            r.cargoType ?? null,
            r.quantity ?? null,
            r.unitPrice ?? null,
            r.km ?? null,
            r.totalPrice ?? null,
            r.rent ?? null,
            r.deposit ?? null,
            r.remaining ?? null,
          ]
        );
      }
    }

    // One table (org tele) using tele.xlsx columns; includes loaded.xlsx cargo rows
    await insertTransportRows('tele', COMBINED_ROWS);

    await pool.query(
      `INSERT INTO app_meta (key, value) VALUES ('transport_seed_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [TRANSPORT_SEED_VERSION]
    );
    console.log(`Transport seed: ${COMBINED_ROWS.length} rows (tele + loaded, tele columns).`);
  }

  console.log('Database ready.');
  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return pool;
}

function numOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapTransportRow(row) {
  return {
    id: row.id,
    orgId: row.org_id || 'tele',
    rowNo: row.row_no,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    destination: row.destination,
    cargoType: row.cargo_type,
    quantity: numOrNull(row.quantity),
    unitPrice: numOrNull(row.unit_price),
    km: numOrNull(row.km),
    totalPrice: numOrNull(row.total_price),
    rent: numOrNull(row.rent),
    deposit: numOrNull(row.deposit),
    remaining: numOrNull(row.remaining),
    createdAt: row.created_at,
  };
}

function mapSaleRow(row) {
  return {
    id: row.id,
    stationId: row.station_id || 'weldeya',
    fuelType: row.fuel_type || 'nafta',
    date: row.sale_date ? row.sale_date.toISOString().slice(0, 10) : null,
    dispatchNo: row.dispatch_no,
    amountInLitre: Number(row.amount_in_litre),
    paid: Number(row.paid),
    m1L: Number(row.m1_l),
    m1R: Number(row.m1_r),
    m2L: Number(row.m2_l),
    m2R: Number(row.m2_r),
    soldInLiter: Number(row.sold_in_liter),
    stak: Number(row.stak),
    differenceInLitre: Number(row.difference_in_litre),
    driversNafta: Number(row.drivers_nafta),
    saleAmountBirr: Number(row.sale_amount_birr),
    adjN: Number(row.adj_n),
    adjO: Number(row.adj_o),
    adjP: Number(row.adj_p),
    adjQ: Number(row.adj_q),
    driversNaftaBirr: Number(row.drivers_nafta_birr),
    black: Number(row.black),
    profit: Number(row.profit),
    diffInBirr: Number(row.diff_in_birr),
    buyPricePerLitre: Number(row.buy_price_per_litre ?? 180.3492),
    sellPricePerLitre: Number(row.sell_price_per_litre ?? 181.23),
    qen: row.qen,
    telebirr: row.telebirr,
    status: row.status || 'closed',
    openedAt: row.opened_at
      ? (row.opened_at instanceof Date ? row.opened_at.toISOString().slice(0, 10) : String(row.opened_at).slice(0, 10))
      : null,
    closedAt: row.closed_at,
    openingStockLitres: Number(row.opening_stock_litres || 0),
    blackPricePerLitre: Number(row.black_price_per_litre ?? row.sell_price_per_litre ?? 181.23),
    truckPlate: row.truck_plate,
    notes: row.notes,
    closeVarianceReason: row.close_variance_reason,
    lockedTotals: row.locked_totals,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

module.exports = { initDatabase, getPool, mapSaleRow, mapTransportRow };
