import iconv from 'iconv-lite';

// Decode a single MIME encoded-word (RFC 2047) with limited charset support.
function decodeWord(charsetRaw: string, encodingRaw: string, text: string): string {
  const charset = String(charsetRaw || '').toLowerCase();
  const encoding = String(encodingRaw || '').toLowerCase();

  // Normalize common Japanese charset aliases
  const charsetMap: Record<string, string> = {
    'utf-8': 'utf-8',
    'us-ascii': 'us-ascii',
    'iso-2022-jp': 'iso-2022-jp',
    'shift_jis': 'shift_jis',
    'shift-jis': 'shift_jis',
    'windows-31j': 'shift_jis',
    'cp932': 'shift_jis',
    'sjis': 'shift_jis',
    'euc-jp': 'euc-jp',
  };
  const normalized = charsetMap[charset];
  if (!normalized) return text; // unsupported charset; return raw

  try {
    if (encoding === 'b') {
      const buf = Buffer.from(text, 'base64');
      return iconv.decode(buf, normalized);
    }
    if (encoding === 'q') {
      // Quoted-printable style: convert to bytes then decode with charset
      const bytes: number[] = [];
      let i = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '=') {
          const hex = text.slice(i + 1, i + 3);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            i += 3;
            continue;
          }
        }
        if (ch === '_') {
          bytes.push(' '.charCodeAt(0));
          i += 1;
          continue;
        }
        bytes.push(ch.charCodeAt(0));
        i += 1;
      }
      const buf = Buffer.from(bytes);
      return iconv.decode(buf, normalized);
    }
  } catch {
    // fall through to raw
  }
  return text;
}

// Minimal MIME encoded-word decoder for Subject/From headers (RFC 2047 subset)
export function decodeMimeWords(value: string): string {
  return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charset: string, encoding: string, text: string) => {
    return decodeWord(charset, encoding, text);
  });
}
