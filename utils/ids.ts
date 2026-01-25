export function generateTraceId(prefix = 'trace'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}`;
}

export function plannedMessageIdFromTrace(traceId: string): string {
  const suffix = traceId.split('_').pop() || traceId.slice(-6);
  return `msg_${suffix}`;
}

