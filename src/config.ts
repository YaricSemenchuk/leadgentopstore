import 'dotenv/config';

/** Выборка топ-стран по выручке App Store — дефолт на старте. */
export const DEFAULT_COUNTRIES = [
  'us', 'cn', 'jp', 'gb', 'de', 'fr', 'kr', 'ca', 'au', 'br',
  'ru', 'it', 'es', 'in', 'mx', 'nl', 'tr', 'sa', 'tw', 'se',
];

/**
 * Категории App Store (iTunes genre id). 'all' — общий чарт.
 * В общем топе одни гиганты; чарты категорий глубже уходят в средний сегмент.
 */
export const DEFAULT_GENRES = [
  'all',
  '6014', // Games
  '7003', // Games / Casual
  '7012', // Games / Puzzle
  '7015', // Games / Simulation
  '7017', // Games / Strategy
  '6013', // Health & Fitness
  '6007', // Productivity
  '6002', // Utilities
  '6008', // Photo & Video
  '6012', // Lifestyle
  '6017', // Education
];

/** Заведомо крупные издатели и их группы: им мотивированный трафик не продать. */
export const DEFAULT_EXCLUDED_PUBLISHERS = [
  'century games', 'playrix', 'plr worldwide', 'king.com', 'tencent', 'netease', 'bytedance',
  'tiktok', 'meta platforms', 'instagram', 'google llc', 'microsoft', 'scopely', 'moon active',
  'playtika', 'dream games', 'supercell', 'zynga', 'take-two', 'electronic arts', 'activision',
  'nintendo', 'niantic', 'roblox', 'miniclip', 'rovio', 'funplus', 'lilith', 'cognosphere',
  'mihoyo', 'netmarble', 'nexon', 'garena', 'x corp', 'openai', 'amazon mobile', 'apple inc',
  'spotify', 'netflix', 'uber technologies', 'snap inc', 'pinterest', 'temu', 'shein', 'alibaba',
];

/** Названия категорий для отображения и для промпта. */
export const GENRE_NAMES: Record<string, string> = {
  all: 'Overall',
  '6000': 'Business', '6001': 'Weather', '6002': 'Utilities', '6003': 'Travel',
  '6004': 'Sports', '6005': 'Social Networking', '6006': 'Reference', '6007': 'Productivity',
  '6008': 'Photo & Video', '6009': 'News', '6010': 'Navigation', '6011': 'Music',
  '6012': 'Lifestyle', '6013': 'Health & Fitness', '6014': 'Games', '6015': 'Finance',
  '6016': 'Entertainment', '6017': 'Education', '6018': 'Books', '6020': 'Medical',
  '6023': 'Food & Drink', '6024': 'Shopping', '6026': 'Developer Tools', '6027': 'Graphics & Design',
  '7001': 'Games / Action', '7002': 'Games / Adventure', '7003': 'Games / Casual',
  '7004': 'Games / Board', '7005': 'Games / Card', '7006': 'Games / Casino',
  '7009': 'Games / Family', '7011': 'Games / Music', '7012': 'Games / Puzzle',
  '7013': 'Games / Racing', '7014': 'Games / Role Playing', '7015': 'Games / Simulation',
  '7016': 'Games / Sports', '7017': 'Games / Strategy', '7018': 'Games / Trivia',
  '7019': 'Games / Word',
};

export type Chart = 'top-free' | 'top-paid' | 'top-grossing';

function list(env: string | undefined, fallback: string[]): string[] {
  const v = (env ?? '').trim();
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function num(env: string | undefined, fallback: number): number {
  const n = Number((env ?? '').trim() || NaN);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  countries: list(process.env.COUNTRIES, DEFAULT_COUNTRIES),
  genres: list(process.env.GENRES, DEFAULT_GENRES),
  charts: list(process.env.CHARTS, ['top-free', 'top-grossing']) as Chart[],
  // фиды Apple отдают максимум 100 позиций на чарт
  chartLimit: Math.min(num(process.env.CHART_LIMIT, 100), 100),
  concurrency: num(process.env.CONCURRENCY, 3),
  // чарты меняются несколько раз в сутки; в пределах TTL повторный проход берёт кэш
  chartCacheHours: num(process.env.CHART_CACHE_HOURS, 12),
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',

  // Таргетинг: promobile продаёт малым и средним издателям, гиганты отсекаются до LLM.
  targeting: {
    // Крупные группы публикуют через разные юрлица (Century Games Innovation и т.п.) —
    // по размеру одного юрлица их не поймать. Подстроки названия издателя, без учёта регистра.
    excludePublishers: list(process.env.EXCLUDE_PUBLISHERS, DEFAULT_EXCLUDED_PUBLISHERS),
    maxAppRatings: num(process.env.MAX_APP_RATINGS, 100_000),
    maxPublisherRatings: num(process.env.MAX_PUBLISHER_RATINGS, 1_000_000),
    maxLlmPerRun: num(process.env.MAX_LLM_PER_RUN, 300),
    requalifyDays: num(process.env.REQUALIFY_DAYS, 7),
  },
  contacts: {
    concurrency: num(process.env.CONTACTS_CONCURRENCY, 3),
    recheckDays: num(process.env.CONTACTS_RECHECK_DAYS, 30),
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'groq',
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: (process.env.ANTHROPIC_MODEL ?? '').trim() || 'claude-sonnet-5-5',
      // классификация: low — модель почти не тратит токены на размышления
      effort: ((process.env.ANTHROPIC_EFFORT ?? '').trim() || 'low') as 'low' | 'medium' | 'high',
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY ?? '',
      model: process.env.GROQ_MODEL ?? 'qwen-2.5-coder-32b',
      baseURL: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
    },
  },
};
