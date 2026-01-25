import { initializeEnvironment } from '../config/environment';
import { initDb } from '../db/sqlite';
import { runAutoDraftOnce } from '../services/autoDraftService';

async function main() {
  initializeEnvironment();
  // Try to init DB for caching/state; ignore if native module mismatch in smoke env
  try { initDb(); } catch {}
  const n = await runAutoDraftOnce();
  console.log(`[smoke:autodraft] drafted=${n}`);
}

main().catch((e) => { console.error('[smoke:autodraft] failed', e); process.exit(1); });
