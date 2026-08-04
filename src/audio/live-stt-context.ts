const MAX_CONTEXT_TERMS = 16;
const MAX_CONTEXT_TERM_CHARS = 64;
const MAX_CONTEXT_CHARS = 256;
const ALLOWED_CONTEXT_TERM = /^[\p{L}\p{M}\p{N} .'-]+$/u;
const GENERIC_MEETING_TERMS = new Set(
  [
    'aksiyon',
    'bütçe',
    'daily',
    'demo',
    'değerlendirme',
    'durum',
    'faz',
    'gündem',
    'haftalık',
    'meeting',
    'plan',
    'planlama',
    'platform',
    'proje',
    'rapor',
    'review',
    'sprint',
    'sync',
    'test',
    'toplantı',
    'weekly',
  ].map((term) => term.toLocaleLowerCase('tr-TR')),
);

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

function contextKey(term: string): string {
  return term.toLocaleLowerCase('tr-TR');
}

function hasNameLikeCase(token: string): boolean {
  const fragments = token.split(/['-]/u).filter(Boolean);
  if (fragments.length === 0) {
    return false;
  }

  const isTitleCase = fragments.every((fragment) => {
    const [first, ...rest] = [...fragment];
    const tail = rest.join('');
    return (
      first === first.toLocaleUpperCase('tr-TR') &&
      first !== first.toLocaleLowerCase('tr-TR') &&
      tail === tail.toLocaleLowerCase('tr-TR')
    );
  });
  const letters = fragments.join('');
  const isBoundedAcronym =
    letters.length <= 16 &&
    letters === letters.toLocaleUpperCase('tr-TR') &&
    letters !== letters.toLocaleLowerCase('tr-TR');

  return isTitleCase || isBoundedAcronym;
}

function normalizeNameLikeToken(candidate: string): string | null {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) {
    return null;
  }
  const letters = normalized.replace(/[^\p{L}\p{M}]/gu, '');
  if (
    letters.length < 3 ||
    GENERIC_MEETING_TERMS.has(contextKey(normalized)) ||
    !hasNameLikeCase(normalized)
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
  const terms: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  const addTerm = (candidate: string): void => {
    const key = contextKey(candidate);
    if (seen.has(key)) {
      return;
    }
    if (terms.length >= MAX_CONTEXT_TERMS || totalChars + candidate.length > MAX_CONTEXT_CHARS) {
      return;
    }
    seen.add(key);
    terms.push(candidate);
    totalChars += candidate.length;
  };

  const segments = normalizedTitle.split(/\s+(?:[-–—|/])\s+|[,;:()[\]{}]+/u);
  for (const segment of segments) {
    const rawTokens = segment.match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) ?? [];
    let run: string[] = [];

    const flushRun = (): void => {
      const uniqueRun = run.filter(
        (term, index) =>
          run.findIndex((candidate) => contextKey(candidate) === contextKey(term)) === index,
      );
      if (uniqueRun.length >= 2) {
        addTerm(uniqueRun.join(' '));
      }
      uniqueRun.forEach(addTerm);
      run = [];
    };

    for (const rawToken of rawTokens) {
      const token = normalizeNameLikeToken(rawToken);
      if (!token) {
        flushRun();
        continue;
      }
      run.push(token);
    }
    flushRun();
  }

  return terms;
}

/**
 * Kullanıcı sözlüğü (gitops#3435): kullanıcının açıkça girdiği adlar başlık
 * çıkarımından ÖNCE gelir — bütçe (16 terim / 256 karakter) dolduğunda
 * kırpılan taraf başlık terimleri olur. Sözlük girdileri kullanıcı seçimi
 * olduğu için isim-görünümü sezgiseline tabi tutulmaz; yalnız karakter kümesi
 * ve uzunluk doğrulanır, geçersiz satırlar sessizce atlanır.
 */
export function combinedLiveSttContextTerms(
  title: string | null | undefined,
  customTerms: readonly string[],
): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  const addTerm = (candidate: string): void => {
    const key = contextKey(candidate);
    if (seen.has(key)) {
      return;
    }
    if (terms.length >= MAX_CONTEXT_TERMS || totalChars + candidate.length > MAX_CONTEXT_CHARS) {
      return;
    }
    seen.add(key);
    terms.push(candidate);
    totalChars += candidate.length;
  };

  for (const candidate of customTerms) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = normalizeCandidate(candidate);
    if (normalized) {
      addTerm(normalized);
    }
  }
  for (const titleTerm of meetingTitleContextTerms(title)) {
    addTerm(titleTerm);
  }

  return terms;
}
