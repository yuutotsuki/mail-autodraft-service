export type Verbosity = 'quiet' | 'normal' | 'debug';

function getVerbosity(): Verbosity {
  const v = String(process.env.LOG_VERBOSITY || 'normal').toLowerCase();
  if (v === 'quiet' || v === 'debug') return v as Verbosity;
  return 'normal';
}

function ts(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

export const logger = {
  debug: (...args: any[]) => {
    if (getVerbosity() === 'debug') {
      try { console.debug('[debug]', ts(), ...args); } catch { /* noop */ }
    }
  },
  info: (...args: any[]) => {
    if (getVerbosity() !== 'quiet') {
      try { console.log('[info]', ts(), ...args); } catch { /* noop */ }
    }
  },
  warn: (...args: any[]) => {
    try { console.warn('[warn]', ts(), ...args); } catch { /* noop */ }
  },
  error: (...args: any[]) => {
    try { console.error('[error]', ts(), ...args); } catch { /* noop */ }
  },
};

export function isDebug(): boolean { return getVerbosity() === 'debug'; }
export function isQuiet(): boolean { return getVerbosity() === 'quiet'; }
