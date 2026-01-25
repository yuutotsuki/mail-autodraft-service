export function extractFirstEmail(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : undefined;
}

export function cleanEmailLike(s?: string): string | undefined {
  if (!s) return undefined;
  // Handles forms like: <mailto:x@y|x@y>, <mailto:x@y>, <x@y>
  const email = extractFirstEmail(s);
  return email || s;
}

