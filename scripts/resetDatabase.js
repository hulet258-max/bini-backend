const { initDatabase, getPool } = require('../src/db');

async function resetDatabase() {
  await initDatabase();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      TRUNCATE TABLE
        fuel_audit_log,
        fuel_money_entries,
        fuel_daily_entries,
        money_transfers,
        sales,
        transports,
        stations,
        meter_baseline,
        meter_baseline_by_fuel,
        app_meta
      RESTART IDENTITY CASCADE
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  // A second initialization applies the normal, versioned WELDYA/ARSI and
  // transportation seeds to the now-empty Bini application database.
  await initDatabase();
  const seededPool = getPool();
  const counts = await seededPool.query(`
    SELECT station_id, fuel_type, COUNT(*)::int AS count
    FROM sales GROUP BY station_id, fuel_type ORDER BY station_id, fuel_type
  `);
  const stations = await seededPool.query('SELECT COUNT(*)::int AS count FROM stations');
  const transports = await seededPool.query('SELECT COUNT(*)::int AS count FROM transports');
  const fuelCounts = counts.rows.map((row) => `${row.station_id}/${row.fuel_type}: ${row.count}`).join(', ');
  console.log(`Fresh database ready: ${stations.rows[0].count} stations (${fuelCounts}), ${transports.rows[0].count} transport rows.`);
  await seededPool.end();
}

resetDatabase().catch((error) => {
  console.error('Database reset failed:', error.message);
  process.exitCode = 1;
});
