import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {api} from '../api/client';
import {ReportEmail} from '../pages/ReportsPage';
vi.mock('../api/client',async original=>({...await original(),isCloudflare:()=>true,api:{getEmailReadiness:vi.fn(),sendReportEmail:vi.fn(),getEmailDelivery:vi.fn()}}));
beforeEach(()=>{vi.resetAllMocks();api.getEmailReadiness.mockResolvedValue({ready:true,provider:'resend'});});
describe('explicit owner report delivery',()=>{
 it('disables sending when provider setup is missing and never asks for an API key',async()=>{
  api.getEmailReadiness.mockResolvedValue({ready:false,reason:'Configure a verified sender.'});render(<ReportEmail userId={7}/>);expect(await screen.findByText(/Email delivery is not configured/)).toHaveTextContent('private report is available to download');expect(screen.getByRole('button',{name:'Send report to my email'})).toBeDisabled();expect(screen.queryByRole('textbox')).toBeNull();expect(api.sendReportEmail).not.toHaveBeenCalled();
 });
 it('queues only after an explicit click, polls the same ticket and labels accepted without claiming delivery',async()=>{
  api.sendReportEmail.mockResolvedValue({id:'email-fixture',state:'queued',attempts:0});api.getEmailDelivery.mockResolvedValue({id:'email-fixture',state:'accepted',attempts:1,accepted_at:'2026-10-25T12:00:00Z',delivered_at:null});render(<ReportEmail userId={7}/>);const user=userEvent.setup();await waitFor(()=>expect(screen.getByRole('button',{name:'Send report to my email'})).toBeEnabled());expect(api.sendReportEmail).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Send report to my email'}));expect(api.sendReportEmail).toHaveBeenCalledWith(7);expect(screen.getByRole('button',{name:'Email queued'})).toBeDisabled();expect(await screen.findByText(/Accepted by email provider/,{},{timeout:4500})).toHaveTextContent('Inbox delivery is not yet verified');expect(api.getEmailDelivery).toHaveBeenCalledWith(7,'email-fixture');expect(screen.queryByText(/^Delivery verified/)).toBeNull();
 });
 it('keeps an uncertain outcome visible and never offers a blind retry',async()=>{
  render(<ReportEmail userId={7} initialDelivery={{id:'uncertain',state:'needs_action',attempts:1,failure_reason:'Check the provider dashboard before sending again.'}}/>);expect(screen.getByText(/Check the provider dashboard/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Send report to my email'})).toBeDisabled();await waitFor(()=>expect(api.getEmailReadiness).toHaveBeenCalled());expect(api.sendReportEmail).not.toHaveBeenCalled();expect(api.getEmailDelivery).not.toHaveBeenCalled();
 });
 it('shows delivery verified only when a verified delivered_at is present',async()=>{
  render(<ReportEmail userId={7} initialDelivery={{id:'verified',state:'accepted',accepted_at:'2026-10-25T12:00:00Z',delivered_at:'2026-10-25T12:01:00Z'}}/>);expect(screen.getByText(/^Delivery verified/)).toBeInTheDocument();expect(screen.queryByText(/Inbox delivery is not yet verified/)).toBeNull();
 });
 it('shows safe action failures and retries status reads without resending',async()=>{
  api.getEmailReadiness.mockRejectedValueOnce({response:{data:{detail:'Email setup temporarily unavailable.'}}}).mockResolvedValue({ready:true});render(<ReportEmail userId={7}/>);expect(await screen.findByRole('alert')).toHaveTextContent('Email setup temporarily unavailable.');await userEvent.setup().click(screen.getByRole('button',{name:'Try again'}));expect(await screen.findByRole('button',{name:'Send report to my email'})).toBeEnabled();expect(api.sendReportEmail).not.toHaveBeenCalled();
 });
});
