import { getExecutionByTraceId } from '../db/sqlite';

export const SAFETY_ENFORCE = process.env.SAFETY_ENFORCE !== '0';

// 実行前に特に注意すべきアクション（承認前は拒否）
const DANGEROUS_ACTIONS = new Set<string>([
  'gmail.send',
  'gmail.saveDraft',
  'calendar.createEvent',
]);

function isDangerous(action?: string): boolean {
  if (!action) return true;
  return DANGEROUS_ACTIONS.has(action);
}

export function mustAllow(params: { trace_id?: string; action?: string }) {
  if (!SAFETY_ENFORCE) return;

  const { trace_id, action } = params;

  // 危険アクションのみゲートを掛ける（承認前は拒否）
  if (!isDangerous(action)) return;

  // trace_idが無い場合は安全側に倒して拒否
  if (!trace_id) {
    throw new Error('[safety] Missing trace_id for dangerous action');
  }

  const rec = getExecutionByTraceId(trace_id);
  if (!rec) {
    throw new Error(`[safety] No execution record for trace_id=${trace_id}`);
  }

  if (rec.status !== 'confirmed') {
    throw new Error(`[safety] Execution not confirmed (status=${rec.status}) trace_id=${trace_id} action=${action}`);
  }
}

// LLMのtool_calls配列をフィルタするための補助（必要時に利用）
export function filterToolCalls<T extends { name?: string }>(calls: T[], trace_id?: string) {
  if (!SAFETY_ENFORCE) return { allowed: calls, blocked: [] as T[] };

  const allowed: T[] = [];
  const blocked: T[] = [];

  for (const call of calls) {
    const action = call?.name;
    if (!isDangerous(action)) {
      allowed.push(call);
      continue;
    }

    try {
      mustAllow({ trace_id, action });
      allowed.push(call);
    } catch (_err) {
      blocked.push(call);
    }
  }

  return { allowed, blocked };
}

