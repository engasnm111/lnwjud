export interface SkillMatchCandidate {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly trustTier?: string;
}

export interface RankedSkillMatch<T extends SkillMatchCandidate = SkillMatchCandidate> {
  readonly skill: T;
  readonly score: number;
  readonly matchedTokens: number;
  readonly explicit: boolean;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'if', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'user', 'when', 'with',
]);

export function rankSkillMatches<T extends SkillMatchCandidate>(
  skills: readonly T[],
  query: string,
  limit = 8,
): readonly RankedSkillMatch<T>[] {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit) || 8));
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return skills.slice(0, boundedLimit).map((skill) => ({ skill, score: 0, matchedTokens: 0, explicit: false }));
  }

  const queryTokens = new Set(tokenize(normalizedQuery));
  return skills
    .map((skill) => scoreSkill(skill, query, normalizedQuery, queryTokens))
    .filter((match): match is RankedSkillMatch<T> => match.score > 0)
    .sort((left, right) => right.score - left.score
      || right.matchedTokens - left.matchedTokens
      || left.skill.id.localeCompare(right.skill.id))
    .slice(0, boundedLimit);
}

export function selectAutoSkillMatches<T extends SkillMatchCandidate>(
  ranked: readonly RankedSkillMatch<T>[],
  maxExplicit = 3,
): readonly RankedSkillMatch<T>[] {
  const explicit = ranked.filter((match) => match.explicit).slice(0, maxExplicit);
  if (explicit.length > 0) return explicit;
  const top = ranked.find((match) => match.skill.trustTier !== 'external');
  return top !== undefined && top.score >= 25 && top.matchedTokens >= 2 ? [top] : [];
}

function scoreSkill<T extends SkillMatchCandidate>(
  skill: T,
  rawQuery: string,
  normalizedQuery: string,
  queryTokens: ReadonlySet<string>,
): RankedSkillMatch<T> {
  const normalizedName = normalizeSearchText(skill.name);
  const normalizedDescription = normalizeSearchText(skill.description ?? '');
  const normalizedId = normalizeSearchText(skill.id);
  const normalizedSource = normalizeSearchText(skill.source ?? '');
  const nameTokens = new Set(tokenize(normalizedName));
  const descriptionTokens = new Set(tokenize(normalizedDescription));
  const idTokens = new Set(tokenize(normalizedId));
  const sourceTokens = new Set(tokenize(normalizedSource));
  const explicit = explicitlyNamesSkill(rawQuery, skill);

  let score = explicit ? 500 : 0;
  let matchedTokens = 0;
  if (normalizedName.length > 0 && normalizedQuery.includes(normalizedName)) score += 120;
  if (normalizedDescription.length > 0 && normalizedDescription.includes(normalizedQuery)) score += 80;

  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      score += 30;
      matchedTokens += 1;
    } else if (descriptionTokens.has(token)) {
      score += 10;
      matchedTokens += 1;
    } else if (idTokens.has(token)) {
      score += 5;
      matchedTokens += 1;
    } else if (sourceTokens.has(token)) {
      score += 2;
      matchedTokens += 1;
    }
  }

  return { skill, score, matchedTokens, explicit };
}

function explicitlyNamesSkill(query: string, skill: SkillMatchCandidate): boolean {
  const lower = query.toLowerCase();
  const name = skill.name.toLowerCase();
  const id = skill.id.toLowerCase();
  return lower.includes(`$${name}`)
    || lower.includes(`skill ${name}`)
    || lower.includes(`skill: ${name}`)
    || lower.includes(id);
}

function tokenize(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value)
      .split(' ')
      .map(canonicalToken)
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  )];
}

function canonicalToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ');
}
