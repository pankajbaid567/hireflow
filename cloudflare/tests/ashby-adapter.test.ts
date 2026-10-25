/** Official public posting API fields; no hosted provider or employer writes. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {verifyDiscoveryDetail} from '../src/intelligence';
import type {Env} from '../src/types';
const base='https://jobs.ashbyhq.com/fixture/role-123',description='Build Python and SQL services for a supervised student engineering project. Write focused tests and documentation, review small changes, and explain data validation to a mentor.';
const posting=(values:Record<string,unknown>={})=>({title:'Python Engineer Intern',jobUrl:base,applyUrl:base+'/application',isListed:true,employmentType:'Intern',location:'Bengaluru, India',descriptionPlain:description,publishedAt:new Date(Date.now()-2*86400000).toISOString(),...values});
function fixture(jobs:unknown[]){const calls:unknown[]=[];vi.stubGlobal('fetch',vi.fn((raw:RequestInfo|URL,init:RequestInit={})=>{calls.push([String(raw),init.method||'GET']);return Response.json({apiVersion:'1',jobs});}));return calls;}
afterEach(()=>vi.unstubAllGlobals());
describe('Ashby official public adapter',()=>{
 it('reads the full API description, canonical listing, official application URL and salary component',async()=>{
  const calls=fixture([posting({compensation:{summaryComponents:[{compensationType:'EquityPercentage',interval:'NONE',minValue:.5,maxValue:1.5},{compensationType:'Salary',interval:'1 MONTH',currencyCode:'INR',minValue:15000,maxValue:25000},{compensationType:'Bonus',interval:'1 YEAR',currencyCode:'INR',minValue:50000,maxValue:50000}]}})]);
  const job:Record<string,any>|null=await verifyDiscoveryDetail({} as Env,{url:base+'/application',title:'Search title',company:'Fixture Employer'});expect(job).toMatchObject({title:'Python Engineer Intern',company:'Fixture Employer',url:base,application_url:base+'/application',description,source:'Ashby',listing_type:'internship',location:'Bengaluru, India'});expect(job!.compensation).toMatchObject({currency:'INR',period:'month',minimum:15000,maximum:25000,annual_minimum:180000,source:'structured'});expect(job!.required_skills).toEqual(['Python','SQL']);expect(calls).toEqual([['https://api.ashbyhq.com/posting-api/job-board/fixture?includeCompensation=true','GET']]);
 });
 it.each([{isListed:false},{isListed:undefined},{jobUrl:'https://wrong.example.com/fixture/role-123'},{publishedAt:new Date(Date.now()-100*86400000).toISOString()}])('rejects unlisted, ambiguous, wrong-host or stale posting metadata %j',async extra=>{fixture([posting(extra)]);expect(await verifyDiscoveryDetail({} as Env,{url:base,title:'Python Intern',company:'Fixture Employer'})).toBeNull();});
 it('ignores unrelated board postings and never accepts an API apply URL to a different host',async()=>{fixture([posting({jobUrl:base+'-other'}),posting({applyUrl:'https://private.example.com/application'})]);const job:Record<string,any>|null=await verifyDiscoveryDetail({} as Env,{url:base,title:'Python Intern',company:'Fixture Employer'});expect(job!.application_url).toBe(base);});
 it('does not invent a single location-specific salary from conflicting compensation summaries',async()=>{fixture([posting({compensation:{summaryComponents:[{compensationType:'Salary',interval:'1 YEAR',currencyCode:'USD',minValue:100000,maxValue:120000},{compensationType:'Salary',interval:'1 YEAR',currencyCode:'INR',minValue:800000,maxValue:1200000}]}})]);const job:Record<string,any>|null=await verifyDiscoveryDetail({} as Env,{url:base,title:'Python Intern',company:'Fixture Employer'});expect(job!.compensation.disclosed).toBe(false);});
 it.each(['Verify you are human','Checking your browser','Log in to view this job','Access to this page has been denied'])('never accepts a successful HTTP interstitial as a JD: %s',async barrier=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Response(`<main>${barrier}. ${'This generic access page is not an employer job description. '.repeat(6)}</main>`)));
  const events:Record<string,any>[]=[];expect(await verifyDiscoveryDetail({} as Env,{url:'https://company.example.com/jobs/one',title:'Python Intern',company:'Fixture Employer'},event=>events.push(event))).toBeNull();expect(events.some(row=>row.reason==='restricted_source_interstitial')).toBe(true);
 });

});
