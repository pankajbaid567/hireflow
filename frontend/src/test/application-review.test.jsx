import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api/client';
import ApplicationReview from '../components/ApplicationReview';

vi.mock('../api/client',async original=>({...await original(),api:{getApplicationReview:vi.fn(),editResume:vi.fn(),rejectResume:vi.fn(),regenerateResume:vi.fn(),approveApplicationReview:vi.fn()}}));
const job={application_id:21,job_id:11,company_name:'Test Co',role_title:'Python Intern',resume_url:'/resumes/7/21/download'};
const draft={summary:'Built Python coursework tools.',skills:['Python'],education:'BTech',projects:[],experience:[],links:[],certifications:[],achievements:[],languages:[]};
const data={resume_version:1,profile_version:3,draft,previous_draft:null,rejected:false,versions:[{version:1,method:'llm_grounded',download_url:'/resumes/7/21/download?version=1'}],questions:[{question:'Why this role?',answer:'My Python coursework is relevant.'},{question:'Do you need sponsorship?',answer:''}]};
beforeEach(()=>{vi.clearAllMocks();api.getApplicationReview.mockResolvedValue(structuredClone(data));});
function mount(){const onClose=vi.fn(),onUpdated=vi.fn();render(<ApplicationReview job={job} onClose={onClose} onUpdated={onUpdated}/>);return{onClose,onUpdated};}
describe('exact PDF and answer review',()=>{
  it('requires a new acknowledgement and sends exact versions and reviewed answers',async()=>{
    api.approveApplicationReview.mockResolvedValue({approved:true});const callbacks=mount(),user=userEvent.setup();
    const approve=await screen.findByRole('button',{name:'Approve PDF and answers'});expect(approve).toBeDisabled();
    expect(screen.getByRole('link',{name:'Open PDF v1'})).toHaveAttribute('href','/api/resumes/7/21/download?version=1');
    expect(screen.getByLabelText('Answer 2')).toHaveValue('');
    await user.click(screen.getByRole('checkbox',{name:/I reviewed PDF v1/}));await user.click(approve);
    expect(api.approveApplicationReview).toHaveBeenCalledWith(21,{resume_version:1,profile_version:3,reviewed:true,answers:{'Why this role?':'My Python coursework is relevant.'}});
    expect(callbacks.onUpdated).toHaveBeenCalled();expect(callbacks.onClose).toHaveBeenCalled();
  });
  it('invalidates the checkbox when an answer changes and preserves an API failure for correction',async()=>{
    api.approveApplicationReview.mockRejectedValue({response:{data:{detail:'Your profile changed. Review again.'}}});mount();const user=userEvent.setup();
    const checkbox=await screen.findByRole('checkbox',{name:/I reviewed PDF v1/});await user.click(checkbox);
    await user.type(screen.getByLabelText('Answer 1'),' I built a planner.');expect(checkbox).not.toBeChecked();
    await user.click(checkbox);await user.click(screen.getByRole('button',{name:'Approve PDF and answers'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your profile changed. Review again.');expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('saves a new immutable version and requires review of that new PDF',async()=>{
    const next={...structuredClone(data),resume_version:2,draft:{...draft,summary:'Built a documented Python planner.'},previous_draft:draft,versions:[{version:2,method:'user_edited',download_url:'/resumes/7/21/download?version=2'},...data.versions]};
    api.editResume.mockResolvedValue(next);api.getApplicationReview.mockResolvedValueOnce(structuredClone(data)).mockResolvedValue(next);mount();const user=userEvent.setup();
    await user.click(await screen.findByRole('button',{name:'Edit this resume'}));
    await user.clear(screen.getByLabelText('Professional summary'));await user.type(screen.getByLabelText('Professional summary'),next.draft.summary);
    await user.click(screen.getByRole('button',{name:'Compare versions'}));expect(screen.getByText('Your edits')).toBeInTheDocument();expect(screen.getByText('Saved version')).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Edit this resume'}));await user.click(screen.getByRole('button',{name:'Save new PDF version'}));
    await waitFor(()=>expect(api.editResume).toHaveBeenCalledWith(21,expect.objectContaining({base_version:1,profile_version:3,draft:expect.objectContaining({summary:next.draft.summary,skills:['Python']})})));
    expect(await screen.findByRole('link',{name:'Open PDF v2'})).toHaveAttribute('href','/api/resumes/7/21/download?version=2');
    expect(screen.getByRole('checkbox',{name:/I reviewed PDF v2/})).not.toBeChecked();expect(screen.getByRole('button',{name:'Approve PDF and answers'})).toBeDisabled();expect(api.approveApplicationReview).not.toHaveBeenCalled();
  });
  it('blocks rejected drafts and exposes bounded regeneration errors without closing',async()=>{
    api.rejectResume.mockResolvedValue({rejected:true});api.regenerateResume.mockRejectedValue({response:{data:{detail:'Please wait ten minutes before retrying.'}}});const callbacks=mount(),user=userEvent.setup();
    await user.click(await screen.findByRole('button',{name:'Reject this PDF'}));
    expect(await screen.findByText(/This resume is rejected/)).toBeInTheDocument();expect(screen.getByRole('checkbox',{name:/I reviewed PDF/})).toBeDisabled();
    await user.click(screen.getByRole('button',{name:'Request a new draft'}));expect(await screen.findByRole('alert')).toHaveTextContent('wait ten minutes');expect(callbacks.onClose).not.toHaveBeenCalled();
  });
  it('allows an explicit additional question without inventing its answer',async()=>{
    api.approveApplicationReview.mockResolvedValue({approved:true});mount();const user=userEvent.setup();
    await user.click(await screen.findByRole('button',{name:'Add a question'}));expect(screen.getByLabelText('Answer 3')).toHaveValue('');
    await user.type(screen.getByLabelText('Question 3'),'When can you start?');await user.type(screen.getByLabelText('Answer 3'),'15 January 2027');
    await user.click(screen.getByRole('checkbox',{name:/I reviewed PDF/}));await user.click(screen.getByRole('button',{name:'Approve PDF and answers'}));
    expect(api.approveApplicationReview).toHaveBeenCalledWith(21,expect.objectContaining({answers:expect.objectContaining({'When can you start?':'15 January 2027'})}));
  });
});
