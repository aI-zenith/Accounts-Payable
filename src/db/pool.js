import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL is not set — database operations will fail until it is configured.'
  );
}

// Neon (and most managed Postgres) require SSL. We force sslmode=require via the
// connection string; the rejectUnauthorized:false relaxation lets the managed
// provider's cert chain be accepted without bundling a CA file.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

export function query(text, params) {
  return pool.query(text, params);
}
