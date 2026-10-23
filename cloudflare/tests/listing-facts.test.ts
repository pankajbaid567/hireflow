import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {canonicalListingUrl,companyAliases,companyKey,compensationFit,enrichListing,listingQuality,parseCompensation,parseExperience} from '../src/listing_details';
import {extractSkills,scoreMatch} from '../src/intelligence';
const cases=JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/listing_contract.json',import.meta.url)),'utf8')) as {id:string;text:string;expected:Record<string,unknown>}[];
describe('evidence-backed listing contract',()=>{
  for(const sample of cases)it(sample.id,()=>expect(parseCompensation(sample.text)).toMatchObject(sample.expected));
  it('does not treat unknown currency/period or unrelated numbers as an INR preference match',()=>{
    expect(compensationFit(parseCompensation('Salary USD 100000/year'),{min_salary:800000},'job')).toBe(.5);
    expect(compensationFit(parseCompensation('Salary INR 100000'),{min_salary:800000},'job')).toBe(.5);
    expect(compensationFit(parseCompensation('3 years experience and 2000000 users'),{min_stipend:15000},'internship')).toBe(.5);
    expect(compensationFit(parseCompensation('Salary INR 6-10 LPA'),{min_salary:800000},'job')).toBe(.7);
    expect(compensationFit(parseCompensation('Unpaid internship'),{min_stipend:15000},'internship')).toBe(.1);
  });
  it('records explicit experience with evidence, without inferring years from dates',()=>{
    expect(parseExperience('2-5 years of experience')).toMatchObject({minimum_years:2,maximum_years:5});
    expect(parseExperience('Experience: 3+ years')).toMatchObject({minimum_years:3,maximum_years:null});
    expect(parseExperience('Founded in 2018. Join our 5-person team.')).toBeNull();
  });
  it('normalizes legal names, explicit aliases and tracking without substring collisions',()=>{
    expect(companyKey('A.C.M.E. Pvt.Ltd.')).toBe(companyKey('ACME'));
    expect(companyKey('Acme Consulting')).not.toBe(companyKey('Acme Software'));
    expect(companyAliases('Acme Technologies',{company_aliases:{Acme:['Acme Technologies']}})).toContain('acme');
    expect(canonicalListingUrl('https://example.com/jobs/1/?utm_source=site&job_id=42#apply')).toBe('https://example.com/jobs/1?job_id=42');
  });
  it('keeps legitimate small technical startups while explaining fee risks',()=>{
    expect(listingQuality('Build Python APIs','Tiny Startup',['Python']).is_spam).toBe(false);
    expect(listingQuality('Python internship. No registration fee required.','Tiny Startup',['Python']).is_spam).toBe(false);
    expect(listingQuality('You must pay a registration fee before interview.','Hiring Team',[]).is_spam).toBe(true);
  });
  it('preserves fields/provenance/unknowns and six-factor weights in normal scoring',()=>{
    const job=enrichListing({title:'Python Engineer',company:'Tiny Startup',url:'https://example.com/jobs/1',description:'Build Python services. Salary INR 6-8 LPA. Requires 2 years experience. Technical interview then HR.',listing_type:'job'},extractSkills);
    expect(job).toMatchObject({source:'example.com',required_skills:['Python'],expires_at:null,company_key:'tiny startup'});
    expect(job.required_experience.minimum_years).toBe(2);expect(job.compensation.annual_minimum).toBe(600000);expect(job.selection_process).toHaveLength(1);
    const result=scoreMatch({skills:['Python'],target_roles:['Python Engineer'],experience_years:2,min_salary:500000},job as any);
    const f=result.factors;expect(result.score).toBeCloseTo(.4*f.skill_match+.2*f.role_fit+.15*f.experience_fit+.1*f.location_match+.1*f.compensation_fit+.05*f.company_signal,4);
  });
});
