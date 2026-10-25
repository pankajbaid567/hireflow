import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import {api} from '../api/client';
import PrepGuidePage from '../pages/PrepGuidePage';
vi.mock('../api/client',async original=>({...await original(),api:{getPrepGuide:vi.fn()}}));
beforeEach(()=>vi.clearAllMocks());
function mount(data){api.getPrepGuide.mockResolvedValue(data);render(<MemoryRouter initialEntries={['/applications/7/prep-guide']}><Routes><Route path="/applications/:applicationId/prep-guide" element={<PrepGuidePage/>}/></Routes></MemoryRouter>);}
describe('prep source evidence and uncertainty',()=>{
 it('shows estimates, exact JD evidence and self-reported topic explanations without hiding source links',async()=>{
  mount({company:'Fictional QA Co',structured_data:{rounds:[{number:1,type:'technical',focus:'Python project',estimated:true},{number:2,type:'HR',focus:'Motivation',estimated:false,evidence:{kind:'career_page',url:'https://company.example.com/careers',quote:'Two rounds: technical and HR.'}}],topics:{strong:['Python'],moderate:['Docker'],gaps:[]},topic_evidence:[{topic:'Python',explanation:'Listed in your profile; proficiency is self-reported.'}],questions:[{category:'behavioral',question:'How would you resolve conflicting booking slots?',focus:'Evidence and communication',evidence:{kind:'jd',quote:'Coordinate clinic appointments and patient booking slots.'}}],company_intel:{stage:'seed',team_size:'42',tech_stack:['Python'],claim_evidence:{stage:[{value:'seed',kind:'job_context_estimate',url:null,quote:null}],team_size:[{value:'42',kind:'public_page',url:'https://company.example.com/about',quote:'Fictional QA Co has 42 employees.'}]},sources:[]}}});
  expect(await screen.findByText('Estimated stage — confirm with the recruiter.')).toBeInTheDocument();expect(screen.getByText('Source-reported stage — the current process may change.')).toBeInTheDocument();
  const user=userEvent.setup();await user.click(screen.getByText('How your topics were grouped'));expect(screen.getByText(/proficiency is self-reported/)).toBeVisible();
  await user.click(screen.getByText('behavioral question'));expect(screen.getByText('Coordinate clinic appointments and patient booking slots.')).toBeVisible();
  await user.click(screen.getByText('Company sources and uncertainty'));expect(screen.getByText('Estimate from supplied listing context')).toBeVisible();expect(screen.getByText('Fictional QA Co has 42 employees.')).toBeVisible();
  expect(within(screen.getByText('Company sources and uncertainty').closest('details')).getByRole('link',{name:'Source'})).toHaveAttribute('href','https://company.example.com/about');
 });
 it('marks undated/historical candidate reports and blocks unsafe source links',async()=>{
  mount({structured_data:{rounds:[],questions:[],topics:{},company_intel:{stage:'unknown',interview_patterns:[{url:'https://www.glassdoor.com/Interview/fictional',summary:'Fictional candidate discussion',date_status:'unknown'},{url:'javascript:alert(1)',summary:'Untrusted report link',date_status:'historical',published_at:'2025-01-01'}]}}});
  expect(await screen.findByText(/Date unknown\. Current interview stages are unconfirmed/)).toBeInTheDocument();expect(screen.getByText(/Historical report.*Current interview stages are unconfirmed/)).toBeInTheDocument();expect(screen.getByText('Untrusted report link').closest('a')).toBeNull();
  expect(screen.getByRole('link',{name:/Fictional candidate discussion/})).toHaveAttribute('rel','noopener noreferrer');
 });
});
