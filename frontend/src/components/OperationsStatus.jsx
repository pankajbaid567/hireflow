import { useEffect, useState } from 'react';
import './OperationsStatus.css';

const failureText = error => typeof error?.response?.data?.detail === 'string' ? error.response.data.detail : 'Service status could not be checked. Please try again.';
const stateText = { healthy:'Available at last check', degraded:'Needs attention', unknown:'Not checked recently', not_configured:'Not configured' };
const metric = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : 'Not measured';
export default function OperationsStatus({ userId, loadStatus, runDiagnostics }) {
  const [data,setData]=useState(null), [loading,setLoading]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState(''), [message,setMessage]=useState('');
  useEffect(()=>{
    let active=true;setData(null);setError('');setMessage('');
    if(!userId || !loadStatus)return;
    setLoading(true);
    Promise.resolve().then(()=>loadStatus(userId)).then(value=>{if(active)setData(value);}).catch(error=>{if(active)setError(failureText(error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[userId,loadStatus]);
  if(!userId || !loadStatus)return null;
  async function refresh(){setLoading(true);setError('');try{setData(await loadStatus(userId));}catch(error){setError(failureText(error));}finally{setLoading(false);}}
  async function diagnose(){setBusy(true);setError('');setMessage('');try{const result=await runDiagnostics(userId);setData(current=>({...current,providers:result.providers || current?.providers || []}));setMessage(result.message || 'Configured model checks completed.');}catch(error){setError(failureText(error));}finally{setBusy(false);}}
  const providers=Array.isArray(data?.providers)?data.providers:[], capacity=data?.capacity, timing=data?.telemetry?.wall_time_ms;
  const issues=providers.some(provider=>provider.state==='degraded'||provider.state==='not_configured') || (data?.alerts || []).length>0;
  return <details className="operations-status"><summary>Service status <span>{loading?'Checking…':issues?'Review availability':'Providers and capacity'}</span></summary><div className="operations-body">
    <p>Model availability and the shared browser allowance can affect preparation and automatic submissions. Diagnostics send a small synthetic prompt, never your resume or profile.</p>
    <div className="operations-actions"><button type="button" className="text-button" disabled={loading||busy} onClick={refresh}>Refresh status</button>{runDiagnostics && <button type="button" className="button button-secondary button-small" disabled={busy||loading} onClick={diagnose}>{busy?'Checking models…':'Check configured models'}</button>}</div>
    {error && <p className="notice notice-error" role="alert">{error}</p>}{message && <p className="notice notice-info" role="status">{message}</p>}
    {providers.length>0 && <ul className="operations-providers">{providers.map((provider,index)=><li key={`${provider.provider}-${provider.model}-${index}`}><strong>{provider.provider} · {provider.model}{provider.role==='fallback'?' · configured fallback':''}</strong><span>{stateText[provider.state] || 'Status unavailable'}</span>{provider.message && <p>{provider.message}</p>}</li>)}</ul>}
    {capacity && <dl className="operations-capacity"><div><dt>Browser slots remaining today</dt><dd>{capacity.remaining_application_slots ?? 'Unknown'}</dd></div><div><dt>Applications waiting</dt><dd>{capacity.queued_applications ?? 'Unknown'}</dd></div><div><dt>Minimum time between submissions</dt><dd>{capacity.submission_delay_seconds ?? 'Unknown'} seconds</dd></div>{capacity.semantic_matching_enabled && <div><dt>New semantic texts remaining today</dt><dd>{capacity.semantic_texts_remaining ?? 'Unknown'} / {capacity.semantic_daily_text_budget ?? 'Unknown'}</dd></div>}</dl>}
    {(data?.alerts || []).map((alert,index)=><p className="notice notice-info" key={index}>{alert}</p>)}
    {timing && <div className="operations-timing"><strong>Request wall time · last {data.telemetry.request_sample_count || 0} samples</strong><p>P50 {metric(timing.p50)} · P95 {metric(timing.p95)} · P99 {metric(timing.p99)}</p><small>Wall time includes network waits. CPU time and isolate memory require Cloudflare platform analytics and are not inferred here.</small></div>}
  </div></details>;
}
