export function getDefaultResponsesModel(): string {
  return process.env.RESPONSES_MODEL_DEFAULT || 'gpt-4.1';
}

export function getPhase1Model(): string {
  return (
    process.env.RESPONSES_MODEL_PHASE1 ||
    process.env.RESPONSES_MODEL_INTENT ||
    'gpt-4.1-mini'
  );
}

export function getPhase2ListModel(): string {
  return (
    process.env.RESPONSES_MODEL_PHASE2_LIST ||
    process.env.RESPONSES_MODEL_LIST ||
    process.env.RESPONSES_MODEL_DEFAULT ||
    'gpt-4.1-mini'
  );
}

export function getAutoDraftModel(): string {
  return (
    process.env.RESPONSES_MODEL_AUTODRAFT ||
    process.env.RESPONSES_MODEL_DEFAULT ||
    'gpt-4.1'
  );
}
