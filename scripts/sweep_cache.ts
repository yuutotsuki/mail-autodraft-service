process.env.ENV = process.env.ENV || 'company';

import { initializeEnvironment } from '../config/environment';
import { initDb, sweepExpiredEmailListCache } from '../db/sqlite';

function nowSec() { return Math.floor(Date.now() / 1000); }

async function main() {
  initializeEnvironment();
  initDb();
  const isProd = (process.env.NODE_ENV === 'production');
  const baseSweepSec = Number(process.env.CACHE_SWEEP_SECONDS || (isProd ? '120' : '30'));
  const graceSec = Number(process.env.CACHE_SWEEP_GRACE_SECONDS || (isProd ? '300' : '60'));
  const maxDelete = Number(process.env.MAX_DELETE_PER_SWEEP || '1000');

  const res = sweepExpiredEmailListCache(nowSec(), graceSec, maxDelete);
  console.log(`[cache.sweep] table=email_list_cache expired=${res.expired} deleted=${res.deleted} grace=${graceSec}s max=${maxDelete}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

