import fs from 'fs';
import path from 'path';
import { hmacUserId, maskEmailAndPhone } from '../utils/pii';
import { generateTraceId } from '../utils/ids';

export type RouteKind = 'compose' | 'responses' | 'gmail_read';

export interface ActionLogInput {
  route: RouteKind;
  shadow: boolean;
  user_id?: string; // raw user id (will be hashed)
  raw_text?: string;
  normalized_text?: string;
  matched_trigger?: string | null;
  match_type?: string | null;
  confidence?: number | null;
  params?: any;
  suggested_action?: string | null;
  result_summary?: string | null;
  session_id?: string | null;
  trace_id?: string | null;
  error?: string | null;
}

function findProjectRoot(): string {
  // Walk up from this file to locate the package.json of this project
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    const anchorTs = path.join(dir, 'slack-bot.ts');
    if (fs.existsSync(pkg) && fs.existsSync(anchorTs)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function logAction(input: ActionLogInput): string /* trace_id */ {
  const ts = new Date();
  const ts_iso = ts.toISOString();
  const day = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}`;
  // Place logs under projectRoot/logs regardless of current working directory
  const projectRoot = findProjectRoot();
  const logDir = path.join(projectRoot, 'logs');
  const logPath = path.join(logDir, `actions-${day}.jsonl`);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

  const trace_id = input.trace_id || generateTraceId('log');
  const session_id = input.session_id || null;
  const user_id_hashed = input.user_id ? hmacUserId(input.user_id) : '';
  const raw_text_masked = maskEmailAndPhone(input.raw_text);
  const normalized_text = maskEmailAndPhone(input.normalized_text);
  const paramsRedacted = safeRedactParams(input.params);
  const record = {
    ts_iso,
    route: input.route,
    trace_id,
    session_id,
    user_id_hashed,
    raw_text_masked,
    normalized_text,
    matched_trigger: input.matched_trigger ?? null,
    match_type: input.match_type ?? null,
    confidence: input.confidence ?? null,
    params: paramsRedacted,
    suggested_action: input.suggested_action ?? null,
    result_summary: input.result_summary ?? null,
    shadow: !!input.shadow,
    error: input.error ?? null,
    schema_version: 'v1',
  } as const;

  const line = JSON.stringify(record);
  try {
    fs.appendFileSync(logPath, line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // As a last resort, print to console to not lose signal
    console.warn('[actionLogger] failed to append; printing to console:', line);
  }
  return trace_id;
}

function safeRedactParams(p: any): any {
  if (!p) return null;
  try {
    const json = JSON.stringify(p);
    const masked = maskEmailAndPhone(json);
    return masked ? JSON.parse(masked) : null;
  } catch {
    // best-effort: return masked string
    return maskEmailAndPhone(String(p));
  }
}
