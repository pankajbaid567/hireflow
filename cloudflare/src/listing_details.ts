/** Evidence-backed listing fields. Unknown pay/experience are never zero. */
export const LISTING_SCHEMA_VERSION = 'listing-v1';
type Data = Record<string, any>;
export type Compensation = { currency: string | null; period: string | null; minimum: number | null; maximum: number | null; annual_minimum: number | null; annual_maximum: number | null; monthly_minimum: number | null; monthly_maximum: number | null; disclosed: boolean; evidence: string | null; source: string };
const bounded = (value: unknown, max = 30000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const amount = (value: unknown): number | null => {if(typeof value==='string'&&!value.trim())return null;const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : value; return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e10 ? n : null;};
const periodName = (value: unknown) => /^(?:year|yearly|annual|annum|p\.a\.)$/i.test(String(value)) ? 'year' : /^(?:month|monthly|mo)$/i.test(String(value)) ? 'month' : /^(?:hour|hourly|hr)$/i.test(String(value)) ? 'hour' : /^(?:day|daily)$/i.test(String(value)) ? 'day' : null;
function pay(currency: string | null, period: string | null, minimum: number | null, maximum: number | null, evidence: string | null, source: string): Compensation {
  if(minimum !== null && maximum !== null && minimum > maximum) [minimum,maximum]=[maximum,minimum];
  const convert=(n:number|null, multiplier:number)=>n===null?null:Math.round(n*multiplier*100)/100;
  return {currency,period,minimum,maximum,annual_minimum:period==='year'?minimum:period==='month'?convert(minimum,12):null,annual_maximum:period==='year'?maximum:period==='month'?convert(maximum,12):null,monthly_minimum:period==='month'?minimum:period==='year'?convert(minimum,1/12):null,monthly_maximum:period==='month'?maximum:period==='year'?convert(maximum,1/12):null,disclosed:minimum!==null||maximum!==null,evidence,source};
}
export function parseCompensation(description: string, structured?: Data | null): Compensation {
  if(structured && typeof structured==='object'){
    const value=structured.value && typeof structured.value==='object'?structured.value:structured;
    const currency=bounded(structured.currency || value.currency,8).toUpperCase() || null;
    const minimum=amount(value.minValue ?? value.min ?? value.value ?? (typeof structured.value==='number'?structured.value:null));
    const maximum=amount(value.maxValue ?? value.max ?? value.value ?? (typeof structured.value==='number'?structured.value:null));
    if(minimum!==null||maximum!==null)return pay(currency,periodName(value.unitText || value.interval || structured.interval),minimum,maximum,JSON.stringify(structured).slice(0,500),'structured');
  }
  const source=bounded(description), money=/(₹|\bINR\b|\bRs\.?|US\$|\bUSD\b|\$|\bEUR\b|€|\bGBP\b|£)\s*([\d,]+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|crores?|k|million)?(?:\s*(?:-|–|—|to)\s*(?:₹|INR|Rs\.?|US\$|USD|\$|EUR|€|GBP|£)?\s*([\d,]+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|crores?|k|million)?)?|\b([\d.]+)(?:\s*(?:-|–|to)\s*([\d.]+))?\s*(LPA)\b/gi;
  const scale=(unit:string)=>/^crore/i.test(unit)?1e7:/^(lpa|lakh|lac)/i.test(unit)?1e5:/^k$/i.test(unit)?1e3:/million/i.test(unit)?1e6:1;
  for(const match of source.matchAll(money)){
    const at=match.index!, prefix=source.slice(Math.max(0,at-100),at), tail=source.slice(at+match[0].length,at+match[0].length+50);
    const anchors=[...prefix.matchAll(/\b(salary|stipend|ctc|compensation|pay|package|remuneration)\b/gi)];
    const costs=[...prefix.matchAll(/\b(budget|funding|revenue|fees?|deposit|investment)\b/gi)];
    if((costs.at(-1)?.index??-1)>(anchors.at(-1)?.index??-1)||!match[8]&&!anchors.length)continue;
    const currency=match[8]?'INR':/^(₹|inr|rs\.?)/i.test(match[1])?'INR':/^(US\$|usd|\$)$/i.test(match[1])?'USD':/^(eur|€)$/i.test(match[1])?'EUR':'GBP';
    const unit=match[5]||match[3]||match[8]||'', minimum=amount(match[6]||match[2]), maximum=amount(match[7]||match[4]||match[6]||match[2]);
    const interval=/\b(lpa)\b/i.test(unit)||/^(?:\s*(?:\/|per\s*)?\s*(?:annum|annual(?:ly)?|year(?:ly)?|p\.a\.))/i.test(tail)?'year':/^(?:\s*(?:\/|per\s*)?\s*(?:month(?:ly)?|mo\b))/i.test(tail)?'month':/^(?:\s*(?:\/|per\s*)?\s*(?:hour(?:ly)?|hr\b))/i.test(tail)?'hour':null;
    return pay(currency,interval,minimum===null?null:minimum*scale(match[3]||unit),maximum===null?null:maximum*scale(unit),source.slice(Math.max(0,at-35),at+match[0].length+45).trim(),'jd_text');
  }
  const unpaid=source.match(/\bunpaid\s+(?:internship|role|position)\b|\b(?:stipend|salary|pay)\s*:\s*(?:none|unpaid|0)\b/i);
  if(unpaid&&!/\b(?:no|not)\s+$/i.test(source.slice(Math.max(0,unpaid.index!-8),unpaid.index)))return pay(null,null,0,0,unpaid[0],'explicit_unpaid');
  return pay(null,null,null,null,null,'not_disclosed');
}
export function compensationFit(compensation: Compensation, profile: Data, listingType: string): number {
  const minimum=Number(listingType==='internship'?profile.min_stipend:profile.min_salary);
  if(!(minimum>0))return 0.5;
  if(compensation.source==='explicit_unpaid')return .1;
  if(compensation.currency!=='INR')return 0.5; // No silent FX conversion.
  const lower=listingType==='internship'?compensation.monthly_minimum:compensation.annual_minimum;
  const upper=listingType==='internship'?compensation.monthly_maximum:compensation.annual_maximum;
  if(lower===null&&upper===null)return 0.5;
  if(lower!==null&&lower>=minimum)return 1;
  if(upper!==null&&upper>=minimum)return 0.7; // Range overlaps preference, not guaranteed.
  return (upper??lower!)>=minimum*.7?0.4:0.1;
}
export function parseExperience(description: string): Data | null {
  const text=bounded(description), range=text.match(/\b(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(\+)?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:(?:relevant|professional|industry|hands[- ]on)\s+)?(?:experience|exp\b)/i) || text.match(/\b(?:experience|exp)\s*(?:required)?\s*[:=-]?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(\+)?\s*(?:years?|yrs?)\b/i);
  if(range){const min=Number(range[1]),max=range[2]?Number(range[2]):null;if(min<=50&&(max===null||max>=min&&max<=50))return {minimum_years:min,maximum_years:max,evidence:range[0],source:'jd_text'};}
  const fresher=text.match(/\b(?:freshers?(?:\s+(?:are\s+)?welcome)?|no (?:prior |professional )?experience (?:is )?required)\b/i);
  return fresher?{minimum_years:0,maximum_years:null,evidence:fresher[0],source:'jd_text'}:null;
}
export function experienceFit(required: Data | null, years: number): number {
  if(!required)return .5;
  if(years<required.minimum_years)return Math.max(.05,years/Math.max(required.minimum_years,1));
  return required.maximum_years!==null&&years>required.maximum_years?Math.max(.3,1-(years-required.maximum_years)*.1):1;
}
export function companyKey(value: string): string {
  let key=bounded(value,300).normalize('NFKC').toLowerCase().replace(/\bpvt\.?\s*ltd\b/g,'pvt ltd').replaceAll('.','').replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  for(let n=0;n<3;n++)key=key.replace(/(?:\s+|^)(?:(?:private|pvt)\s+(?:limited|ltd)|pvt|limited|ltd|incorporated|inc|llc|llp|corp(?:oration)?|co|company)$/,'').trim();
  return key;
}
/** Explicit owner-supplied aliases, never substring/brand-family guesses. */
export function companyAliases(value:string, profile:Data={}):string[]{
  const target=companyKey(value), keys=new Set([target]);
  const aliases=profile.company_aliases;
  if(aliases&&typeof aliases==='object'&&!Array.isArray(aliases)){
    for(const [name,values] of Object.entries(aliases).slice(0,50)){
      if(!Array.isArray(values))continue;
      const group=[companyKey(name),...values.slice(0,10).filter((item):item is string=>typeof item==='string'&&item.length<=300).map(companyKey)];
      if(group.includes(target))group.filter(Boolean).forEach(key=>keys.add(key));
    }
  }
  return [...keys].filter(Boolean);
}
export function canonicalListingUrl(raw: string): string {
  const url=new URL(raw);url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^(utm_.+|fbclid|gclid|trackingid)$/i.test(key))url.searchParams.delete(key);
  url.searchParams.sort();url.pathname=url.pathname.replace(/\/$/,'')||'/';return url.href;
}
export function sourceName(raw: string): string {
  try{const host=new URL(raw).hostname.toLowerCase().replace(/^www\./,'');for(const [suffix,label] of [['internshala.com','Internshala'],['wellfound.com','Wellfound'],['linkedin.com','LinkedIn'],['naukri.com','Naukri'],['greenhouse.io','Greenhouse'],['lever.co','Lever'],['ashbyhq.com','Ashby']])if(host===suffix||host.endsWith(`.${suffix}`))return label;return host;}catch{return 'unknown';}
}
export function listingQuality(description: string, company: string, skills: string[]) {
  const text=bounded(description);const suspicious=[...text.matchAll(/\b(?:pay|deposit|transfer)\b.{0,60}\b(?:registration|processing|training|security)\s*(?:fee|deposit)|\b(?:registration|processing)\s*fee\b.{0,35}\b(?:required|mandatory|payable)\b/ig)];
  const scams=suspicious.filter(value=>!/(?:\bno\b|\bnever\b|\bwithout\b|do not|don't)/i.test(text.slice(Math.max(0,value.index!-18),value.index)));
  const reasons:string[]=[];if(scams.length)reasons.push('Listing requests an upfront recruitment fee or deposit.');if(!company.trim())reasons.push('Employer name is missing.');if(text.length<100&&!skills.length)reasons.push('Description is sparse and has no identifiable role skills.');
  const risk=scams.length ? .95 : !company.trim() ? .8 : text.length<100&&!skills.length ? .45 : .05;
  return {spam_confidence:risk,is_spam:risk>=.8,quality_reason:reasons.join(' ')||'No configured fee/sparsity risk rule matched; employer legitimacy is not independently verified.',quality_method:'evidence_rules_v1'};
}
export function enrichListing(raw: Data, skills: (text:string)=>string[]): Data {
  const description=bounded(raw.description), sourceText=`${bounded(raw.title,300)} ${description}`;
  let supplied:unknown=raw.required_skills||raw.skills||[];try{if(typeof supplied==='string')supplied=supplied.trim().startsWith('[')?JSON.parse(supplied):supplied.split(/[,;|\n]/);}catch{supplied=[];}
  const explicit=Array.isArray(supplied)?supplied.filter((value):value is string=>typeof value==='string'&&value.trim().length<=80&&value.trim().length>0&&sourceText.toLowerCase().includes(value.trim().toLowerCase())).slice(0,50).map(value=>value.trim()):[];
  const required_skills=[...new Set([...skills(sourceText),...explicit])], canonical_url=canonicalListingUrl(raw.url);
  const provenance=raw.provenance && typeof raw.provenance==='object'?raw.provenance:{kind:'manual',url:canonical_url};
  const expires=raw.expires_at||raw.validThrough;
  const date=expires?new Date(/^\d{4}-\d{2}-\d{2}$/.test(expires)?`${expires}T23:59:59.999Z`:expires):null;
  const selection=description.split(/\n|(?<=[.!?])\s+/).filter(line=>/\b(interview|selection (?:process|round)|technical round|hr round|coding (?:round|test|assessment))\b/i.test(line)).map(line=>line.trim().slice(0,500)).filter(Boolean).slice(0,8);
  let existing:Data|null=null;try{existing=typeof raw.compensation==='string'?JSON.parse(raw.compensation):raw.compensation;}catch{}
  const compensation=existing?.source==='structured'?existing:parseCompensation(description,raw.baseSalary||raw.salaryRange||raw.structured_compensation);
  return {...raw,url:canonical_url,canonical_url,application_url:canonicalListingUrl(raw.application_url||canonical_url),source:sourceName(canonical_url),required_skills,required_experience:parseExperience(description),expires_at:date&&Number.isFinite(date.getTime())?date.toISOString():null,selection_process:selection,compensation,provenance:{...provenance,schema_version:LISTING_SCHEMA_VERSION,fields:{required_skills:'explicit_skill_mentions',required_experience:'explicit_experience_text',selection_process:'verbatim_jd_sentences',compensation:compensation.source,posting_date:raw.posted_date?'source_reported':'unknown',expiry_date:date?'source_reported':'unknown'}},company_key:companyKey(raw.company),...listingQuality(description,raw.company,required_skills)};
}
