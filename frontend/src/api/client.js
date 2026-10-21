import axios from 'axios';

export const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
const client = axios.create({ baseURL: API_BASE, timeout: 120000 });

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

export const api = {
  getProfile: id => client.get(`/profile/${id}`).then(r => r.data),
  saveProfile: (data, id) => (id ? client.patch(`/profile/${id}`, data) : client.post('/profile', data)).then(r => r.data),
  getPlan: id => client.get(`/weekly-plan/${id}`).then(r => r.data),
  swapJob: (id, remove_job_id, add_job_id) => client.post(`/weekly-plan/${id}/swap`, { remove_job_id, add_job_id }).then(r => r.data),
  confirmPlan: (id, confirmed_job_ids) => client.post(`/weekly-plan/${id}/confirm`, { confirmed_job_ids }).then(r => r.data),
  getApplications: (id, params) => client.get(`/applications/${id}`, { params }).then(r => r.data),
  getPrepGuide: id => client.get(`/applications/${id}/prep-guide`).then(r => r.data),
  getResumes: id => client.get(`/resumes/${id}`).then(r => r.data),
  getReport: id => client.get(`/report/${id}/latest`).then(r => r.data),
  generateReport: id => client.post(`/report/${id}/generate`).then(r => r.data),
};
export default client;
