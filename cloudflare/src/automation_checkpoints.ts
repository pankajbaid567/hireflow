import { Buffer } from 'node:buffer';
import type { Env } from './types';
import { first, run } from './storage';

export interface AutomationCheckpoint {
  binding: string;
  applicationUrl: string;
  url: string;
  phase: 'ready' | 'advancing' | 'submitting' | 'submitted' | 'uncertain';
  step: number;
  signature: string;
  fields_filled: string[];
  mutation_started: boolean;
  storage: { cookies: any[]; origins: any[] };
  session_storage: { origin: string; values: Record<string, string> }[];
}
export interface AutomationCheckpointStore {
  load(): Promise<AutomationCheckpoint | null>;
  save(checkpoint: AutomationCheckpoint): Promise<void>;
}

async function key(env: Env) {
  if (!env.ACCESS_CODE || env.ACCESS_CODE.length < 24) throw new Error('Private checkpoint encryption is unavailable');
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hireflow-automation-checkpoint-v1:${env.ACCESS_CODE}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const aad = (id: number, review: string, binding: string) => new TextEncoder().encode(`${id}:${review}:${binding}`);

/** Private encrypted state, scoped to one application and immutable review. */
export function checkpointStore(env: Env, applicationId: number, reviewId: string, binding: string): AutomationCheckpointStore {
  return {
    async load() {
      const row = await first(env, 'SELECT * FROM automation_checkpoints WHERE application_id=?', applicationId);
      if (!row) return null;
      // A previous uncertain final submission remains a hard stop even if its
      // browser session expires or a different review is later prepared.
      if (row.phase === 'submitting' || row.phase === 'submitted' || row.phase === 'uncertain' || row.phase === 'advancing' &&
          (Date.parse(row.expires_at) <= Date.now() || row.binding !== binding || row.review_id !== reviewId)) {
        return { binding: row.binding, applicationUrl: '', url: '', phase: row.phase, step: row.step,
          signature: '', fields_filled: [], mutation_started: true,
          storage: { cookies: [], origins: [] }, session_storage: [] };
      }
      if (row.binding !== binding || row.review_id !== reviewId || Date.parse(row.expires_at) <= Date.now()) return null;
      try {
        const [iv, ciphertext] = row.encrypted_state.split('.').map((value: string) => new Uint8Array(Buffer.from(value, 'base64')));
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(applicationId, reviewId, binding) }, await key(env), ciphertext);
        const result = JSON.parse(new TextDecoder().decode(plaintext)) as AutomationCheckpoint;
        if (result.binding !== binding || result.phase !== row.phase || result.step !== row.step) throw new Error();
        return result;
      } catch { throw new Error('Private browser checkpoint could not be restored. Continue manually.'); }
    },
    async save(checkpoint) {
      if (checkpoint.binding !== binding) throw new Error('Application review changed');
      const plaintext = new TextEncoder().encode(JSON.stringify(checkpoint));
      if (plaintext.length > 96 * 1024) throw new Error('Private browser checkpoint exceeds the supported size');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(applicationId, reviewId, binding) }, await key(env), plaintext);
      const state = `${Buffer.from(iv).toString('base64')}.${Buffer.from(encrypted).toString('base64')}`;
      const result = await run(env, `INSERT INTO automation_checkpoints(application_id,review_id,binding,phase,step,encrypted_state,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET review_id=excluded.review_id,binding=excluded.binding,
        phase=excluded.phase,step=excluded.step,encrypted_state=excluded.encrypted_state,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE automation_checkpoints.phase='ready' OR
          (automation_checkpoints.phase='advancing' AND automation_checkpoints.binding=excluded.binding AND automation_checkpoints.review_id=excluded.review_id) OR
          (automation_checkpoints.binding=excluded.binding AND automation_checkpoints.review_id=excluded.review_id AND
           automation_checkpoints.phase='submitting' AND excluded.phase IN ('submitting','submitted','uncertain')) OR
          (automation_checkpoints.binding=excluded.binding AND automation_checkpoints.review_id=excluded.review_id AND
           automation_checkpoints.phase=excluded.phase AND excluded.phase IN ('submitted','uncertain'))`,
      applicationId,reviewId,binding,checkpoint.phase,checkpoint.step,state,new Date(Date.now()+24*3600000).toISOString(),new Date().toISOString());
      if (!result.meta.changes) throw new Error('An earlier submission cannot be replayed');
    },
  };
}

/** A lost worker can resume only a completed pre-submit step without a POST in flight. */
export async function resumableCheckpoint(env: Env, applicationId: number): Promise<boolean> {
  const row = await first(env, 'SELECT phase,expires_at FROM automation_checkpoints WHERE application_id=?', applicationId);
  return Boolean(row && row.phase === 'ready' && Date.parse(row.expires_at) > Date.now());
}
