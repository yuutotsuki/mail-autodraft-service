export function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return /^(1|true|on|yes)$/i.test(v);
}

export function intEnv(name: string, def: number): number {
  const v = Number(process.env[name] || '');
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const FEATURE_PHASE3_ACTIONS = boolEnv('FEATURE_PHASE3_ACTIONS', false);
export const FEATURE_MAIL_ACTIONS_DRYRUN = boolEnv('FEATURE_MAIL_ACTIONS_DRYRUN', true);
export const MAX_SEND_PER_SWEEP = intEnv('MAX_SEND_PER_SWEEP', 5);
export const SEND_SWEEP_SECONDS = intEnv('SEND_SWEEP_SECONDS', 60);

// Comma-separated domains or special token 'self'
export function getAllowedSendDomains(): string[] {
  const raw = (process.env.ALLOWED_SEND_DOMAINS || 'self').trim();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Resolve dry-run enablement with alias priority
// FEATURE_MAIL_ACTIONS_DRYRUN ＞ PHASE3_MODE==='dryrun'
export function resolveDryRunEnabled(): { enabled: boolean; source: 'FEATURE_MAIL_ACTIONS_DRYRUN' | 'PHASE3_MODE' | 'default' } {
  if (FEATURE_MAIL_ACTIONS_DRYRUN) return { enabled: true, source: 'FEATURE_MAIL_ACTIONS_DRYRUN' };
  const mode = (process.env.PHASE3_MODE || '').toLowerCase();
  if (mode === 'dryrun') return { enabled: true, source: 'PHASE3_MODE' };
  return { enabled: false, source: 'default' };
}

