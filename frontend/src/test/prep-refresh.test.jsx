import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {api} from '../api/client';
import PrepGuidePage from '../pages/PrepGuidePage';
vi.mock('../api/client',async original=>({...await original(),isCloudflare:()=>true,api:{getPrepGuide:vi.fn(),refreshPrepGuide:vi.fn(),getPrepExports:vi.fn(),getPrepExport:vi.fn(),startPrepExport:vi.fn()}}));
beforeEach(()=>vi.clearAllMocks());
const mount=()=>render(<MemoryRouter initialEntries={['/applications/7/prep-guide']}><Routes><Route path="/applications/:applicationId/prep-guide" element={<PrepGuidePage/>}/></Routes></MemoryRouter>);
describe('explicit prep refresh UI',()=>{
 it('keeps the saved guide while polling, renders the refreshed guide, and rechecks immutable export staleness',async()=>{
  const old={company:'Fixture Employer',guide_revision:1,guide_stale:true,questions:[{category:'behavioral',question:'Saved legacy preparation question.'}],rounds:[],topics:{},company_intel:{}};
  const fresh={...old,guide_revision:2,guide_stale:false,refresh:{state:'completed',requested_at:new Date().toISOString()},questions:[{category:'behavioral',question:'Refreshed booking-slot preparation question.'}]};
  api.getPrepGuide.mockResolvedValueOnce(old).mockResolvedValue(fresh);api.refreshPrepGuide.mockResolvedValue({state:'queued',requested_at:new Date().toISOString()});api.getPrepExports.mockResolvedValue({latest:null,versions:[]});mount();
  await screen.findByText('This saved guide uses an older profile or listing. Refresh it to prepare from your current context.');const user=userEvent.setup();await user.click(screen.getByText('behavioral question'));expect(screen.getByText('Saved legacy preparation question.')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'Refresh preparation'}));expect(screen.getByText('Saved legacy preparation question.')).toBeVisible();expect(screen.getByRole('button',{name:'Refresh preparation'})).toBeDisabled();expect(api.refreshPrepGuide).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(screen.getByText('Refreshed booking-slot preparation question.')).toBeVisible(),{timeout:5000});expect(screen.getByText('Preparation refreshed. Previous export downloads keep their original content.')).toBeInTheDocument();await waitFor(()=>expect(api.getPrepExports).toHaveBeenCalledTimes(2));expect(api.refreshPrepGuide).toHaveBeenCalledTimes(1);
 });
 it('shows a clean refresh error without removing the saved guide',async()=>{
  api.getPrepGuide.mockResolvedValue({questions:[{category:'technical',question:'Existing source-grounded Python question.'}],rounds:[],topics:{},company_intel:{}});api.getPrepExports.mockResolvedValue({latest:null,versions:[]});api.refreshPrepGuide.mockRejectedValue({response:{status:429,data:{detail:'Three preparation refreshes were requested. Wait ten minutes before trying again.'}}});mount();
  const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Refresh preparation'}));expect(await screen.findByText(/Three preparation refreshes were requested/)).toBeInTheDocument();expect(screen.getByText('Existing source-grounded Python question.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Refresh preparation'})).toBeEnabled();
 });
});
