export interface Env extends Omit<CloudflareBindings, 'APPLICATION_QUEUE' | 'SUBMISSION_DELAY_SECONDS' | 'OPERATIONS_RETENTION_DAYS'> {
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
  WEBAUTHN_RP_ID?: string;
  SUBMISSION_DELAY_SECONDS?: string;
  OPERATIONS_RETENTION_DAYS?: string;
  OPERATION_CONTEXT?: {correlation_id: string; user_id?: number; cycle_id?: string};
}
export interface Task { application_id: number; kind: 'apply' | 'prep'; review_id?: string; }
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
