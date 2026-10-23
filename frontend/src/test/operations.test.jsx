import { describe,expect,it,vi } from 'vitest';
import { render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OperationsStatus from '../components/OperationsStatus';
const status={providers:[{provider:'groq',model:'configured-model',state:'degraded',message:'The provider is rate limited.'},{provider:'gemini',model:'configured-gemini',state:'unknown',message:'Not checked recently.'}],capacity:{remaining_application_slots:2,queued_applications:3,submission_delay_seconds:25},telemetry:{request_sample_count:20,wall_time_ms:{p50:40,p95:200,p99:400}},alerts:['Most of the daily browser allowance has been reserved.']};
describe('operations status',()=>{
  it('loads status without automatically requesting billable model diagnostics',async()=>{
    const loadStatus=vi.fn().mockResolvedValue(status),runDiagnostics=vi.fn();render(<OperationsStatus userId="7" loadStatus={loadStatus} runDiagnostics={runDiagnostics}/>);
    await userEvent.setup().click(screen.getByText('Service status',{selector:'summary'}));
    expect(await screen.findByText('groq · configured-model')).toBeVisible();expect(screen.getByText('Needs attention')).toBeVisible();expect(screen.getByText('Not checked recently.')).toBeVisible();
    expect(screen.getByText('25 seconds')).toBeInTheDocument();expect(screen.getByText(/P50 40 ms/)).toBeInTheDocument();expect(screen.getByText(/CPU time and isolate memory/)).toBeInTheDocument();expect(runDiagnostics).not.toHaveBeenCalled();
  });
  it('only checks configured models after the explicit button click and updates their returned health',async()=>{
    const runDiagnostics=vi.fn().mockResolvedValue({providers:[{provider:'groq',model:'configured-model',state:'healthy',message:'The most recent provider request succeeded.'}],message:'Synthetic model checks completed.'});
    render(<OperationsStatus userId="7" loadStatus={vi.fn().mockResolvedValue(status)} runDiagnostics={runDiagnostics}/>);const user=userEvent.setup();await user.click(screen.getByText('Service status',{selector:'summary'}));await screen.findByText('Needs attention');
    await user.click(screen.getByRole('button',{name:'Check configured models'}));expect(runDiagnostics).toHaveBeenCalledWith('7');expect(await screen.findByRole('status')).toHaveTextContent('Synthetic model checks completed.');expect(screen.getByText('Available at last check')).toBeVisible();expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });
  it('shows an actionable diagnostic rate limit without claiming success',async()=>{
    render(<OperationsStatus userId="7" loadStatus={vi.fn().mockResolvedValue(status)} runDiagnostics={vi.fn().mockRejectedValue({response:{data:{detail:'Model diagnostics can run once per minute.'}}})}/>);const user=userEvent.setup();await user.click(screen.getByText('Service status',{selector:'summary'}));await screen.findByText('Needs attention');await user.click(screen.getByRole('button',{name:'Check configured models'}));expect(await screen.findByRole('alert')).toHaveTextContent('once per minute');expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('clears a stale load error when refreshing succeeds',async()=>{
    const loadStatus=vi.fn().mockRejectedValueOnce(new Error('private internal error')).mockResolvedValue(status);render(<OperationsStatus userId="7" loadStatus={loadStatus}/>);const user=userEvent.setup();await user.click(screen.getByText('Service status',{selector:'summary'}));expect(await screen.findByRole('alert')).not.toHaveTextContent('private internal error');await user.click(screen.getByRole('button',{name:'Refresh status'}));await screen.findByText('Needs attention');expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not access operations without a signed-in profile',()=>{
    const loadStatus=vi.fn();render(<OperationsStatus userId="" loadStatus={loadStatus}/>);expect(screen.queryByText('Service status')).not.toBeInTheDocument();expect(loadStatus).not.toHaveBeenCalled();
  });
});
