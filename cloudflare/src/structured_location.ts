/** Source-reported JSON-LD geography, without inferring a country from a city. */
type Data = Record<string, unknown>;
type Place = {locality:string;region:string;country:string;name?:string};
type Eligibility = {type:string;name:string};
const object = (value:unknown):Data => value && typeof value==='object' && !Array.isArray(value) ? value as Data : {};
const bounded = (value:unknown):string => typeof value==='string' ? value.trim().replace(/\s+/g,' ').slice(0,160) : '';
const items = (value:unknown):unknown[] => (Array.isArray(value)?value:value==null?[]:[value]).slice(0,10);
const named = (value:unknown):string => bounded(value) || bounded(object(value).name);
// These exact aliases cover the confirmed IN loss and its US/PR regression
// cases. Other explicit country names/codes remain as supplied by the source.
const countryAliases:Record<string,string> = {
  in:'India',ind:'India',india:'India',us:'United States',usa:'United States',
  'u.s.':'United States','u.s.a.':'United States','united states':'United States',
  'united states of america':'United States',pr:'Puerto Rico','puerto rico':'Puerto Rico',
};
function country(value:unknown):string {
  const name=named(value),key=name.toLowerCase();return Object.hasOwn(countryAliases,key)?countryAliases[key]:name;
}
export function structuredJobLocation(posting:Data):{
  location:string;
  evidence:{remote:boolean;workplaces:Place[];applicant_locations:Eligibility[];selected_from:string};
} {
  const remote=items(posting.jobLocationType).some(value=>bounded(value).toUpperCase()==='TELECOMMUTE');
  const workplaces=items(posting.jobLocation).map(value=>{
    const place=object(value),address=object(place.address);
    const name=bounded(place.name);
    return {locality:bounded(address.addressLocality),region:bounded(address.addressRegion),country:country(address.addressCountry),...(name?{name}:{})};
  }).filter(place=>place.locality||place.region||place.country||place.name);
  const applicant_locations=items(posting.applicantLocationRequirements).map(value=>{
    const area=object(value),type=bounded(area['@type']);
    return {type:type||'unspecified',name:type==='Country'?country(area.name):named(value)};
  }).filter(area=>area.name);
  const workplaceText=workplaces.map(place=>[...new Set([place.locality,place.region,place.country].filter(Boolean))].join(', ')||place.name||'').join('; ');
  // Remote applicant restrictions take precedence over an employer's postal
  // address. In-person eligibility never substitutes for the workplace.
  const eligibilityText=applicant_locations.map(area=>area.name).join('; ');
  const selected_from=remote&&eligibilityText?'applicant_location_requirements':workplaceText?'job_location':remote?'job_location_type':'unknown';
  const selected=remote&&eligibilityText?eligibilityText:workplaceText;
  return {location:(remote?`Remote${selected?' — '+selected:''}`:selected).slice(0,300),evidence:{remote,workplaces,applicant_locations,selected_from}};
}
