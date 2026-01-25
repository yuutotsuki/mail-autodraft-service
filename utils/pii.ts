import crypto from 'crypto';

// Very simple PII maskers (minimum viable). Can be hardened later.
export function maskEmailAndPhone(input?: any): string | undefined {
  if (input == null) return input;
  const s = String(input);
  // Emails
  let out = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  // E.164-like or domestic numbers (very loose): +81-90-1234-5678, 090-1234-5678, 03-1234-5678, etc.
  out = out.replace(/(?:(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)\d{2,4}[\s-]?\d{3,4})/g, (m) => {
    // Heuristic: treat as phone if it has at least 8 digits
    const digits = m.replace(/\D/g, '');
    return digits.length >= 8 ? '[PHONE]' : m;
  });
  // Collapse newlines to spaces for JSONL safety
  out = out.replace(/[\r\n]+/g, ' ').trim();
  return out;
}

export function hmacUserId(userId: string): string {
  const salt = process.env.HASH_SALT || 'dev-salt';
  return crypto.createHmac('sha256', salt).update(userId || '').digest('hex');
}

