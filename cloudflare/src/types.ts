export interface Env extends Omit<CloudflareBindings, 'APPLICATION_QUEUE' | 'SUBMISSION_DELAY_SECONDS' | 'OPERATIONS_RETENTION_DAYS' | 'AI' | 'SEMANTIC_MATCHING_ENABLED' | 'SEMANTIC_DAILY_TEXT_BUDGET' | 'PLAN_WORK_IN_QUEUE' | 'DISCOVERY_SHARED_GUARDS' | 'DISCOVERY_DAILY_SEARCH_BUDGET' | 'DISCOVERY_DAILY_DETAIL_BUDGET' | 'DYNAMIC_SOURCE_ENABLED' | 'DYNAMIC_SOURCE_HOSTS'> {
  FILES?: R2Bucket;
  APPLICATION_QUEUE: Queue<Task>;
  ACCESS_CODE: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  TAVILY_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  RESEND_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  SENDGRID_WEBHOOK_PUBLIC_KEY?: string;
  DYNAMIC_SOURCE_ENABLED?: string;
  DYNAMIC_SOURCE_HOSTS?: string;
  WEBAUTHN_RP_ID?: string;
  AI?: Ai;
  SEMANTIC_MATCHING_ENABLED?: string;
  SEMANTIC_DAILY_TEXT_BUDGET?: string;
  PLAN_WORK_IN_QUEUE?: string;
  DISCOVERY_DAILY_SEARCH_BUDGET?: string;
  DISCOVERY_DAILY_DETAIL_BUDGET?: string;
  DISCOVERY_SHARED_GUARDS?: string;
  SUBMISSION_DELAY_SECONDS?: string;
  OPERATIONS_RETENTION_DAYS?: string;
  OPERATION_CONTEXT?: {correlation_id: string; user_id?: number; cycle_id?: string};
}
export type Task = { application_id: number; kind: 'apply' | 'prep'; review_id?: string; refresh_token?: string; } | {kind:'discover';discovery_id:string} | {kind:'maintenance'} | {kind:'plan';application_id:number;token:string} | {kind:'prep_export';export_id:string} | {kind:'discovery_cycle';cycle_id:string} | {kind:'weekly_schedule';run_id:string} | {kind:'workspace_backup';id:string} | {kind:'workspace_delete';id:string} | {kind:'email_delivery';delivery_id:string};
export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
export function weekStart(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
export function parsed<T = any>(value: any, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}
