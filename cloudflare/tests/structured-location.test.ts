/** Regression shapes from public source metadata; descriptions are synthetic. */
import {afterEach,describe,expect,it,vi} from 'vitest';
// Import only the real policy; these parser cases perform no plan/database work.
vi.mock('../src/plans',()=>({addJobs:()=>{},getPlan:()=>{}}));
import {verifyDiscoveryDetail} from '../src/intelligence';
import {discoveryFit} from '../src/discovery_cycles';
import {structuredJobLocation} from '../src/structured_location';
import type {Env} from '../src/types';
const description='Build Python APIs in a supervised engineering internship. Write focused tests, document interfaces, and discuss data validation with a mentor.';
const profile={mode:'internship',skills:['Python'],preferred_locations:['India'],experience_years:0};
const address=(addressCountry:unknown='IN')=>({'@type':'Place',address:{'@type':'PostalAddress',addressLocality:'Kolkata',addressRegion:'West Bengal',addressCountry}});
async function parse(extra:Record<string,unknown>){
  const posting={'@type':'JobPosting',title:'Python Engineer Intern',hiringOrganization:{name:'Synthetic Employer'},description,employmentType:'INTERN',...extra};
  vi.stubGlobal('fetch',vi.fn(()=>new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script><article>${description}</article>`)));
  const job=await verifyDiscoveryDetail({} as Env,{url:'https://internshala.com/internship/detail/synthetic-python-intern',title:'Python Engineer Intern'});
  expect(job).not.toBeNull();return job as NonNullable<typeof job> & {provenance:Record<string,any>};
}
afterEach(()=>vi.unstubAllGlobals());
describe('structured source location and eligibility',()=>{
  it('retains Internshala IN eligibility instead of reducing the remote listing to Kolkata',async()=>{
    const job=await parse({jobLocation:[address()],jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'IN'}});
    expect(job.location).toBe('Remote — India');expect(discoveryFit(job,profile)).toMatchObject({accepted:true,geography:'explicit_location'});
    expect(job.provenance.location).toEqual({remote:true,workplaces:[{locality:'Kolkata',region:'West Bengal',country:'India'}],applicant_locations:[{type:'Country',name:'India'}],selected_from:'applicant_location_requirements'});
  });
  it.each(['IN','India',{'@type':'Country',name:'IN'}])('retains an explicit postal country, including a Country object: %j',async addressCountry=>{
    const job=await parse({jobLocation:address(addressCountry)});
    expect(job.location).toBe('Kolkata, West Bengal, India');expect(discoveryFit(job,profile).accepted).toBe(true);
  });
  it('does not treat an India office as permission for a US-only remote role',async()=>{
    const job=await parse({jobLocation:address(),jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'US'}});
    expect(job.location).toBe('Remote — United States');expect(job.provenance.location.workplaces[0].country).toBe('India');expect(discoveryFit(job,profile)).toMatchObject({accepted:false,reason:'geography_mismatch'});
  });
  it('does not substitute eligible applicant country for an in-person US workplace',async()=>{
    const job=await parse({jobLocation:{address:{addressLocality:'San Francisco',addressRegion:'CA',addressCountry:'US'}},applicantLocationRequirements:{'@type':'Country',name:'IN'}});
    expect(job.location).toBe('San Francisco, CA, United States');expect(discoveryFit(job,profile).accepted).toBe(false);
  });
  it('does not infer India from a city, generic remote label or incidental JD reference',async()=>{
    const cityOnly=await parse({jobLocation:{address:{addressLocality:'Kolkata'}}});expect(cityOnly.location).toBe('Kolkata');expect(discoveryFit(cityOnly,profile).accepted).toBe(false);
    const remote=await parse({jobLocationType:'TELECOMMUTE',description:description+' Our customers include India.'});expect(remote.location).toBe('Remote');expect(discoveryFit(remote,profile).accepted).toBe(false);
  });
  it('retains multiple explicitly permitted countries without inventing worldwide eligibility',async()=>{
    const job=await parse({jobLocationType:'TELECOMMUTE',applicantLocationRequirements:[{'@type':'Country',name:'IN'},{'@type':'Country',name:'US'}]});
    expect(job.location).toBe('Remote — India; United States');expect(discoveryFit(job,profile).accepted).toBe(true);expect(job.location).not.toContain('worldwide');
    expect(structuredJobLocation({jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name:'ZZ'}}).location).toBe('Remote — ZZ');
  });
  it.each(['__proto__','constructor','toString'])('never treats inherited object keys as country aliases: %s',name=>{
    expect(structuredJobLocation({jobLocationType:'TELECOMMUTE',applicantLocationRequirements:{'@type':'Country',name}}).location).toBe(`Remote — ${name}`);
  });
  it.each([
    {source:'ashby',url:'https://jobs.ashbyhq.com/synthetic/role-123',location:'San Francisco, CA'},
    {source:'greenhouse',url:'https://job-boards.greenhouse.io/synthetic/jobs/123',location:'San Juan, Puerto Rico'},
  ])('preserves the correct $source rejection for $location',async fixture=>{
    vi.stubGlobal('fetch',vi.fn(()=>Response.json(fixture.source==='ashby'?{jobs:[{title:'Python Engineer Intern',descriptionPlain:description,employmentType:'Intern',location:fixture.location,isRemote:false,isListed:true,jobUrl:fixture.url}]}:{title:'Python Engineer Intern',company_name:'Synthetic Employer',content:description,location:{name:fixture.location}})));
    const job=await verifyDiscoveryDetail({} as Env,{url:fixture.url,title:'Python Engineer Intern',company:'Synthetic Employer'});
    expect(job).not.toBeNull();expect(job!.location).toBe(fixture.location);expect(discoveryFit(job!,profile)).toMatchObject({accepted:false,reason:'geography_mismatch'});
  });
});
