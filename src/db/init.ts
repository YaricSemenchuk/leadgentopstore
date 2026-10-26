import { initSchema, pool } from './pool.js';

await initSchema();
console.log('✅ schema ready');
await pool.end();
