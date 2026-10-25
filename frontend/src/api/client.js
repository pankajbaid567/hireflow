import axios from 'axios';

export const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
export const isCloudflare = () => import.meta.env.VITE_DEPLOYMENT_TARGET === 'cloudflare';
const client = axios.create({ baseURL: API_BASE, timeout: 120000, withCredentials: true });

export function errorMessage(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(item => `${item.loc?.slice(1).join(' ') || 'Field'}: ${item.msg}`).join('. ');
  if (error?.code === 'ECONNABORTED') return 'The request took too long. Please try again.';
  if (error?.request && !error?.response) return 'Cannot reach HireFlow. Check that the API is running and try again.';
  return error?.message || 'Something went wrong. Please try again.';
}

export function externalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Backend download paths must go through the same API origin as JSON requests.
export function artifactUrl(path) {
  if (!path || typeof path !== 'string') return null;
  if (/^https?:\/\//i.test(path)) return externalUrl(path);
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (API_BASE && path.startsWith(`${API_BASE}/`)) return path;
  return `${API_BASE}${path}`;
}

const DISCOVERY_WAIT_MS = 180000;
const DISCOVERY_POLL_MS = 1500;
const discoveryTimeout = () => new Error('Opportunity search took too long. Please try again shortly.');
const discoveryCancelled = () => Object.assign(new Error('Stopped waiting for opportunity search.'), { name: 'AbortError' });
const invalidDiscovery = () => new Error('The search response could not be read. Please try again.');
function discoveryFailure(data) {
  const message = typeof data?.detail === 'string' && data.detail.trim() ? data.detail.trim().slice(0, 500) : 'Opportunity search could not be completed. Please try again.';
  return Object.assign(new Error(message), { response: { status: 503, data: { detail: message, sources: Array.isArray(data?.sources) ? data.sources : [], warnings: Array.isArray(data?.warnings) ? data.warnings : [] } } });
}
function discoveryPause(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(discoveryCancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, DISCOVERY_POLL_MS);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** One durable search, then private reads. Polling never launches another job. */
async function discoverJobs(id, { signal } = {}) {
  const userId = Number(id);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Open your profile before searching for opportunities.');
  if (signal?.aborted) throw discoveryCancelled();
  const controller = new AbortController(), deadline = Date.now() + DISCOVERY_WAIT_MS;
  let timedOut = false, rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const stop = () => rejectStopped(timedOut ? discoveryTimeout() : discoveryCancelled());
  controller.signal.addEventListener('abort', stop, { once: true });
  const parentAbort = () => controller.abort();
  signal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DISCOVERY_WAIT_MS);
  const work = async () => {
    const first = await client.post(`/jobs/${userId}/discover`, undefined, { signal: controller.signal, timeout: Math.min(120000, DISCOVERY_WAIT_MS) });
    let data = first.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidDiscovery();
    if (data.state === 'failed') throw discoveryFailure(data);
    // Older synchronous backends return the complete result without a state.
    if (first.status !== 202 && (!data.state || data.state === 'completed')) return data;
    const discoveryId = data.discovery_id;
    if (typeof discoveryId !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(discoveryId)) throw invalidDiscovery();
    const pollPath = `/jobs/${userId}/discover/${discoveryId}`;
    for (;;) {
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.discovery_id !== discoveryId || data.poll_url !== undefined && data.poll_url !== pollPath) throw invalidDiscovery();
      if (data.state === 'failed') throw discoveryFailure(data);
      if (data.state === 'completed') return data;
      if (!['queued', 'running'].includes(data.state)) throw invalidDiscovery();
      if (Date.now() >= deadline) throw discoveryTimeout();
      await discoveryPause(controller.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw discoveryTimeout();
      data = (await client.get(pollPath, { signal: controller.signal, timeout: Math.min(15000, remaining) })).data;
    }
  };
  try { return await Promise.race([work(), stopped]); }
  catch (error) {
    if (timedOut) throw discoveryTimeout();
    if (signal?.aborted) throw discoveryCancelled();
    if (error?.code === 'ECONNABORTED') throw discoveryTimeout();
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', parentAbort); controller.signal.removeEventListener('abort', stop);
  }
}

export const api = {
  getProfile: id => client.get(`/profile/${id}`).then(r => r.data),
  saveProfile: (data, id) => (id ? client.patch(`/profile/${id}`, data) : client.post('/profile', data)).then(r => r.data),
  getSession: () => client.get('/session').then(r => r.data),
  logoutSession: () => client.post('/session/logout').then(r => r.data),
  consumeTransfer: token => client.post('/session/transfer/consume', { token }).then(r => r.data),
  getAccountSecurity: () => client.get('/account/security').then(r => r.data),
  createPasskeyOptions: () => client.post('/account/passkeys/options', {}).then(r => r.data),
  registerPasskey: data => client.post('/account/passkeys/register', data).then(r => r.data),
  deletePasskey: id => client.delete(`/account/passkeys/${encodeURIComponent(id)}`).then(r => r.data),
  rotateRecoveryKeys: () => client.post('/account/recovery-keys/rotate', {}).then(r => r.data),
  revokeSession: id => client.delete(`/account/sessions/${encodeURIComponent(id)}`).then(r => r.data),
  revokeAllSessions: () => client.post('/account/sessions/revoke-all', {}).then(r => r.data),
  passkeyLoginOptions: () => client.post('/account/passkeys/login-options', {}).then(r => r.data),
  passkeyLoginVerify: data => client.post('/account/passkeys/login-verify', data).then(r => r.data),
  recoverWorkspace: data => client.post('/account/recover', data).then(r => r.data),
  getOperations: id => client.get(`/operations/${id}`).then(r => r.data),
  runModelDiagnostics: id => client.post(`/operations/${id}/diagnostics`, {}).then(r => r.data),
  discoverJobs,
  addJob: (id, data) => client.post(`/jobs/${id}`, data).then(r => r.data),
  getPlan: id => client.get(`/weekly-plan/${id}`).then(r => r.data),
  refreshMatching: id => client.post(`/weekly-plan/${id}/refresh-matches`, {}).then(r => r.data),
  swapJob: (id, remove_job_id, add_job_id) => client.post(`/weekly-plan/${id}/swap`, { remove_job_id, add_job_id }).then(r => r.data),
  confirmPlan: (id, confirmed_job_ids, review_ids) => client.post(`/weekly-plan/${id}/confirm`, { confirmed_job_ids, ...(review_ids ? { review_ids } : {}) }).then(r => r.data),
  getResumeDraft: applicationId => client.get(`/applications/${applicationId}/resume-draft`).then(r => r.data),
  editResume: (applicationId, data) => client.put(`/applications/${applicationId}/resume-draft`, data).then(r => r.data),
  rejectResume: (applicationId, resume_version) => client.post(`/applications/${applicationId}/resume-reject`, { resume_version }).then(r => r.data),
  regenerateResume: (applicationId, resume_version) => client.post(`/applications/${applicationId}/resume-regenerate`, { resume_version }).then(r => r.data),
  getApplicationReview: applicationId => client.get(`/applications/${applicationId}/review`).then(r => r.data),
  approveApplicationReview: (applicationId, data) => client.post(`/applications/${applicationId}/review`, data).then(r => r.data),
  cancelApplication: applicationId => client.post(`/applications/${applicationId}/cancel`, {}).then(r => r.data),
  getApplications: (id, params) => client.get(`/applications/${id}`, { params }).then(r => r.data),
  getPrepGuide: id => client.get(`/applications/${id}/prep-guide`).then(r => r.data),
  getResumes: id => client.get(`/resumes/${id}`).then(r => r.data),
  getReport: id => client.get(`/report/${id}/latest`).then(r => r.data),
  generateReport: id => client.post(`/report/${id}/generate`).then(r => r.data),
};
export default client;
