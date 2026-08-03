import 'dotenv/config';
import { getTiDBPool } from '../src/db/tidb.js';

async function main() {
  console.log('Checking environment variables...');
  const vars = ['TIDB_HOST', 'TIDB_PORT', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
  for (const v of vars) {
    console.log(`  ${v}: ${process.env[v] ? 'PRESENT' : 'MISSING'}`);
  }

  console.log('\nConnecting to TiDB and running SELECT 1...');
  const pool = getTiDBPool();
  try {
    const [selectResult] = await pool.query('SELECT 1 AS ok');
    console.log('✓ SELECT 1 Success:', selectResult);

    console.log('\nRunning SHOW CREATE TABLE products...');
    const [showResult] = await pool.query('SHOW CREATE TABLE products');
    console.log('✓ SHOW CREATE TABLE Success:');
    console.log(showResult[0]['Create Table'] || showResult);
  } catch (err) {
    console.error('\n✗ Error occurred during connection/query:');
    console.error('  Message:', err.message);
    console.error('  Code:', err.code);
    console.error('  Errno:', err.errno);
    console.error('  SqlState:', err.sqlState);
    console.error('  Fatal:', err.fatal);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
