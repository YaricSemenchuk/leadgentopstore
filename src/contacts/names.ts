/**
 * Имена людей и шаблоны почты компании: «yavuz@fusegames.io» + «Yavuz Kara» → шаблон {first}.
 * Шаблон берём только из адреса, который совпал с именем известного человека, — тогда по нему
 * можно составить адреса остальных людей компании (с пометкой «по шаблону, не проверен»).
 */

export interface NameParts {
  first: string;
  last: string | null;
}

// Буквы, которые NFKD не раскладывает на латиницу + диакритику.
const FOLD: Record<string, string> = { ı: 'i', ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th' };

/** «Şükrü Çelik» → «sukru celik»; не-латиница (кириллица, иероглифы) остаётся и потом отбрасывается. */
export function asciiFold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ıłøæœßđðþ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'sir', 'phd', 'mba', 'md', 'jr', 'sr', 'ii', 'iii']);

/** Имя и фамилия латиницей: «Emre Kaya, MBA» → emre / kaya; «Jon J.» → jon / null. */
export function nameParts(full: string | null | undefined): NameParts | null {
  if (!full) return null;
  const words = asciiFold(full.split(/[,(|]/)[0])
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z'-]/g, '').replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 0 && !HONORIFICS.has(w));
  const usable = words.filter((w) => w.length >= 2);
  if (usable.length === 0) return null;
  const first = usable[0].replace(/['-]/g, '');
  const last = usable.length > 1 ? usable[usable.length - 1].replace(/['-]/g, '') : null;
  return first.length >= 2 ? { first, last } : null;
}

/** Самые частые шаблоны корпоративной почты, по убыванию распространённости. */
export const PATTERNS = [
  '{first}', '{first}.{last}', '{f}{last}', '{first}{last}', '{first}_{last}', '{f}.{last}',
  '{first}{l}', '{last}', '{last}.{first}', '{first}-{last}', '{last}{f}', '{first}.{l}', '{last}{first}',
] as const;

export function renderPattern(pattern: string, p: NameParts): string | null {
  if (!p.last && /\{(last|l)\}/.test(pattern)) return null;
  return pattern
    .replace('{first}', p.first)
    .replace('{last}', p.last ?? '')
    .replace('{f}', p.first[0])
    .replace('{l}', p.last?.[0] ?? '');
}

/** Шаблон, по которому из имени получается эта локальная часть; null — не этот человек. */
export function matchPattern(local: string, p: NameParts): string | null {
  const l = local.toLowerCase();
  for (const pattern of PATTERNS) {
    // {first} и {last} по отдельности — только для имён от 3 букв: «li@» слишком случайно
    if ((pattern === '{first}' && p.first.length < 3) || (pattern === '{last}' && (p.last?.length ?? 0) < 3)) continue;
    if (renderPattern(pattern, p) === l) return pattern;
  }
  return null;
}

/** Локальная часть содержит имя или фамилию человека (от 3 букв): «yavuz.k», «ann.lee». */
export function mentionsName(local: string, p: NameParts): boolean {
  const l = local.toLowerCase();
  return (p.first.length >= 3 && l.includes(p.first)) || (!!p.last && p.last.length >= 4 && l.includes(p.last));
}
