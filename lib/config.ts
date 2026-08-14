/**
 * Typed application configuration, read from environment variables.
 *
 * Credentials live only in Vercel env vars / .env.local. Nothing here is ever
 * rendered to a browser or written to a log.
 */

export interface Config {
  trelloKey: string;
  trelloToken: string;
  trelloBoardId: string;
  trelloMemberId: string;
  todoListId: string;
  doingListId: string;
  codeReviewListId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  webhookSecret: string;
  appBaseUrl: string;
  /** Max claims per Lagos day. 0 = unlimited. */
  dailyLimit: number;
}

const REQUIRED = [
  'TRELLO_KEY',
  'TRELLO_TOKEN',
  'TRELLO_BOARD_ID',
  'TRELLO_MEMBER_ID',
  'TODO_LIST_ID',
  'DOING_LIST_ID',
  'CODE_REVIEW_LIST_ID',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'WEBHOOK_SECRET',
] as const;

/**
 * Validates and returns the configuration. Throws if any required variable is
 * missing so misconfiguration fails loudly instead of silently misbehaving.
 */
export function getConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    trelloKey: env.TRELLO_KEY!,
    trelloToken: env.TRELLO_TOKEN!,
    trelloBoardId: env.TRELLO_BOARD_ID!,
    trelloMemberId: env.TRELLO_MEMBER_ID!,
    todoListId: env.TODO_LIST_ID!,
    doingListId: env.DOING_LIST_ID!,
    codeReviewListId: env.CODE_REVIEW_LIST_ID!,
    supabaseUrl: env.SUPABASE_URL!,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY!,
    webhookSecret: env.WEBHOOK_SECRET!,
    appBaseUrl: (env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
    dailyLimit: parseDailyLimit(env.DAILY_LIMIT),
  };
}

/** DAILY_LIMIT: positive integer, or 0 for unlimited. Defaults to 1 (current behavior). */
function parseDailyLimit(raw: string | undefined): number {
  if (!raw?.trim()) return 1;
  const value = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid DAILY_LIMIT: "${raw}" — use 0 (unlimited) or a positive integer.`);
  }
  return value;
}
