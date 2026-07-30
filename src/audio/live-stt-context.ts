const MAX_CONTEXT_TERMS = 32;
const MAX_CONTEXT_TERM_CHARS = 64;
const MAX_CONTEXT_CHARS = 512;
const ALLOWED_CONTEXT_TERM = /^[\p{L}\p{M}\p{N} .'-]+$/u;

function normalizeCandidate(candidate: string): string | null {
  const normalized = candidate.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (
    normalized.length < 2 ||
    normalized.length > MAX_CONTEXT_TERM_CHARS ||
    !ALLOWED_CONTEXT_TERM.test(normalized) ||
    !/\p{L}/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function meetingTitleContextTerms(title: string | null | undefined): string[] {
  if (!title || /[\p{Cc}\p{Cf}]/u.test(title)) {
    return [];
  }

  const normalizedTitle = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const candidates = [
    normalizedTitle,
    ...normalizedTitle
      .split(/[^\p{L}\p{M}\p{N}.'-]+/u)
      .filter((candidate) => /\p{L}/u.test(candidate)),
  ];
  const terms: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) {
      continue;
    }
    if (terms.length >= MAX_CONTEXT_TERMS || totalChars + normalized.length > MAX_CONTEXT_CHARS) {
      break;
    }
    seen.add(key);
    terms.push(normalized);
    totalChars += normalized.length;
  }

  return terms;
}
