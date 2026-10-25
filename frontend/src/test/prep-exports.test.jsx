import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {api} from '../api/client';
import PrepGuidePage from '../pages/PrepGuidePage';
vi.mock('../api/client',async original=>({...await original(),isCloudflare:()=>true,api:{getPrepGuide:vi.fn(),getPrepExports:vi.fn(),startPrepExport:vi.fn(),getPrepExport:vi.fn()}}));
const ready={id:'export-one',version:1,state:'ready',stale:false,created_at:'2026-10-25T12:00:00Z',html_url:'/applications/7/prep-guide/exports/export-one/html',pdf_url:'/applications/7/prep-guide/exports/export-one/pdf'};
function mount(){render(<MemoryRouter initialEntries={['/applications/7/prep-guide']}><Routes><Route path="/applications/:applicationId/prep-guide" element={<PrepGuidePage/>}/></Routes></MemoryRouter>);}
beforeEach(()=>{vi.resetAllMocks();api.getPrepGuide.mockResolvedValue({company:'Fixture Co',role:'Python Intern',rounds:[],topics:{},resources:{},questions:[]});api.getPrepExports.mockResolvedValue({latest:null,versions:[]});});
describe('private prep guide export controls',()=>{
 it('creates exports explicitly, polls pending work and shows authenticated versioned links',async()=>{
  api.startPrepExport.mockResolvedValue({id:'export-one',version:1,state:'queued'});api.getPrepExport.mockResolvedValue(ready);mount();const panel=await screen.findByRole('region',{name:'Private guide exports'}).catch(()=>screen.getByLabelText('Private guide exports'));const user=userEvent.setup();
  await user.click(within(panel).getByRole('button',{name:'Create private exports'}));expect(api.startPrepExport).toHaveBeenCalledWith('7',{regenerate:false});expect(within(panel).getByRole('button',{name:'Create new export version'})).toBeDisabled();
  await waitFor(()=>expect(within(panel).getByRole('link',{name:'Download PDF v1'})).toHaveAttribute('href','/api'+ready.pdf_url),{timeout:4000});expect(api.getPrepExport).toHaveBeenCalledWith('7','export-one');expect(within(panel).getByRole('link',{name:'Open HTML v1'})).toHaveAttribute('rel','noopener noreferrer');expect(within(panel).getByRole('link',{name:'Open HTML v1'})).toHaveAttribute('target','_blank');
 });
 it('labels stale immutable snapshots and keeps previous version downloads',async()=>{
  const previous={...ready,id:'older',version:1};const current={...ready,id:'newer',version:2,stale:true};api.getPrepExports.mockResolvedValue({latest:current,versions:[current,previous]});mount();expect(await screen.findByText(/Your guide or profile changed after this export/)).toBeInTheDocument();expect(screen.getByRole('link',{name:'Download PDF v2'})).toBeInTheDocument();await userEvent.setup().click(screen.getByText('Previous export versions'));expect(screen.getByRole('link',{name:'Download PDF v1'})).toBeInTheDocument();
 });
 it.each(['expired','failed'])('explains %s exports and allows an explicit replacement',async state=>{
  api.getPrepExports.mockResolvedValue({latest:{id:'old',version:1,state,failure_reason:'Create a new export from your saved guide.'},versions:[]});api.startPrepExport.mockResolvedValue({...ready,id:'replacement',version:2});mount();expect(await screen.findByText('Create a new export from your saved guide.')).toBeInTheDocument();await userEvent.setup().click(screen.getByRole('button',{name:'Create new export version'}));expect(api.startPrepExport).toHaveBeenCalledWith('7',{regenerate:true});
 });
 it('keeps the saved guide usable after API errors and can retry export metadata',async()=>{
  api.getPrepExports.mockRejectedValueOnce({response:{data:{detail:'Export service temporarily unavailable.'}}}).mockResolvedValue({latest:ready,versions:[ready]});mount();expect(await screen.findByRole('alert')).toHaveTextContent('Export service temporarily unavailable.');expect(screen.getByRole('heading',{name:'Your study compass'})).toBeInTheDocument();await userEvent.setup().click(screen.getByRole('button',{name:'Try again'}));expect(await screen.findByRole('link',{name:'Download PDF v1'})).toBeInTheDocument();
 });
});
