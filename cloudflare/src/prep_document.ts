/** Standalone guide renderer, with per-document fonts and no resume-shaped content. */
import {UnicodePdfFonts,ResumeFormatError,assertComplexScriptBudget} from './resume_unicode';
import {validatePublicUrl} from './public_url';
import {type Row,parsed} from './types';

type Paragraph={text:string;url?:string};
type Section={title:string;paragraphs:Paragraph[]};
export type PrepDocument={title:string;subtitle:string;version:number;generated_at:string;exported_at:string;sections:Section[]};
const PREP_REGULAR_WIDTHS = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const PREP_BOLD_WIDTHS = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const pdfLiteral=(s:string)=>s.replace(/([\\()])/g,'\\$1');
const clean=(value:unknown)=>String(value??'').normalize('NFC').replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\r\n?/g,'\n').replace(/[\t\u00a0]/g,' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'');
function show(value:unknown,depth=0):string {if(depth>6)throw new ResumeFormatError('The guide evidence is too deeply nested to export safely. Simplify the saved guide; no content was discarded.');return Array.isArray(value)?value.map(v=>show(v,depth+1)).join('; '):value&&typeof value==='object'?Object.entries(value).map(([k,v])=>`${k.replaceAll('_',' ')}: ${show(v,depth+1)}`).join('; '):clean(value);}
const array=(value:unknown):any[]=>Array.isArray(value)?value:[];
export function safePrepLink(value:unknown):string|undefined {try{return typeof value==='string'?validatePublicUrl(value):undefined;}catch{return undefined;}}
const evidence=(value:unknown,label='Evidence'):Paragraph[]=>array(Array.isArray(value)?value:value?[value]:[]).map(item=>({text:`${label}: ${show(item)}`,url:safePrepLink(item?.url)}));
export function prepDocument(snapshot:Row,version:number,exportedAt:string):PrepDocument {
  const guide=parsed<Row>(snapshot.guide,{}),intel=parsed<Row>(snapshot.company_intel,{}),sections:Section[]=[];
  const section=(title:string,paragraphs:Paragraph[])=>sections.push({title,paragraphs:paragraphs.length?paragraphs:[{text:'No evidence recorded for this section.'}]});
  section('About this guide',[
    {text:`Generated ${snapshot.guide_created_at}. Exported ${exportedAt}. Export version ${version}.`},
    {text:`Guide revision ${snapshot.guide_revision}; captured profile version ${snapshot.profile_version}; listing facts version ${snapshot.job_version}.`},
    {text:`Guide generation profile version: ${snapshot.source_profile_version??'not recorded (legacy guide)'}. Guide generation listing version: ${snapshot.source_job_version??'not recorded (legacy guide)'}.`},
    {text:'Interview rounds are predictions, not a confirmed company process. Resource availability was checked by the guide generator where evidence is available; this export performs no fresh web research.'},
    ...(guide.prediction_kind?[{text:`Round prediction basis: ${show(guide.prediction_kind)}`}]:[]),
    ...(snapshot.listing_url?[{text:`Original listing: ${snapshot.listing_url}`,url:safePrepLink(snapshot.listing_url)}]:[]),
  ]);
  const rounds=array(guide.rounds?.rounds||guide.round_prediction?.rounds||guide.rounds);
  section('Interview rounds',rounds.flatMap((r,index)=>[{text:`Round ${r.number??index+1}: ${show(r.type||r.title)}${r.estimated===true?' (estimated)':r.estimated===false?' (stated in evidence)':''}. Focus: ${show(r.focus||r.focus_areas||r.description)}.`},...evidence(r.evidence)]));
  const topics=guide.topics||guide.topic_analysis||{};
  section('Topics to study',[...[['strong','Strong'],['moderate','Moderate'],['gaps','Gaps']].map(([key,label])=>({text:`${label}: ${show(topics[key]||(key==='gaps'?topics.gap:[]))||'None recorded'}`})),...evidence(guide.topic_evidence,'Topic evidence')]);
  const resources:Paragraph[]=[];
  for(const [topic,links]of Object.entries(guide.resources||{})){
    resources.push({text:topic});
    for(const link of array(links))resources.push({text:`${show(link.title||link.url)}${link.description?` - ${show(link.description)}`:''}${link.checked_at?`\nChecked: ${show(link.checked_at)}`:''}\n${show(link.url)}`,url:safePrepLink(link.url)});
  }
  section('Learning resources and citations',resources);
  section('Mock interview questions',array(guide.questions||guide.mock_questions).flatMap((q,index)=>[{text:`${index+1}. [${show(q.category||'practice')}] ${show(q.question||q.text)}${q.hint?`\nHint: ${show(q.hint)}`:''}${q.focus?`\nFocus: ${show(q.focus)}`:''}${q.level?`\nLevel: ${show(q.level)}`:''}`},...evidence(q.evidence)]));
  section('Company evidence',[
    {text:`Stage: ${show(intel.stage)||'Unknown'}`},{text:`Estimated team size: ${show(intel.team_size??intel.estimated_team_size)||'Unknown'}`},
    {text:`Tech stack: ${show(intel.tech_stack)||'Unknown'}`},
    ...['stage_evidence','team_size_evidence','tech_stack_evidence'].flatMap(key=>intel[key]?[{text:`${key.replaceAll('_',' ')}: ${show(intel[key])}`}]:[]),
    ...Object.entries(intel.claim_evidence||{}).flatMap(([key,value])=>evidence(value,`${key.replaceAll('_',' ')} evidence`)),
    ...evidence(intel.career_sources,'Career-page evidence'),
    ...array(intel.sources).map(source=>({text:typeof source==='string'?source:show(source.title||source.summary||source.url),url:safePrepLink(typeof source==='string'?source:source.url)})),
  ]);
  section('Recent news',array(intel.recent_news).map(news=>({text:typeof news==='string'?news:`${show(news.date||news.published_at)||'Date not recorded'} - ${show(news.title||news.summary)}\n${show(news.url)}`,url:safePrepLink(news.url)})));
  section('Interview evidence and guidance',[
    ...array(intel.interview_patterns).map(item=>({text:typeof item==='string'?item:`${show(item.summary||item.pattern||item.title)}\nReport date: ${show(item.published_at)||'unknown'}; date status: ${show(item.date_status)||'unknown'}${item.note?`\n${show(item.note)}`:''}\n${show(item.url)}`,url:safePrepLink(item.url)})),
    ...[intel.interview_review_status,intel.fallback_guidance].filter(Boolean).map(value=>({text:show(value)})),
  ]);
  const warnings=array(guide.warnings).map(value=>({text:show(value)}));
  if(snapshot.source_profile_version==null||snapshot.source_job_version==null)warnings.push({text:'This saved guide predates source-version tracking. Its original generation versions are unknown; the export records the captured workspace versions without inventing missing provenance.'});
  if(snapshot.source_profile_version!=null&&snapshot.source_profile_version!==snapshot.profile_version)warnings.push({text:'The saved guide was generated for an earlier profile version. Review its topics against your current profile; exporting does not regenerate advice.'});
  section('Evidence limits and notes',[...warnings,...(guide.content?[{text:show(guide.content)}]:[]),...(!warnings.length&&!guide.content?[{text:'No additional warnings were recorded for this saved guide.'}]:[])]);
  const document={title:`${clean(snapshot.company)} - interview preparation`,subtitle:clean(snapshot.role),version,generated_at:snapshot.guide_created_at,exported_at:exportedAt,sections};
  if(JSON.stringify(document).length>120000||sections.reduce((sum,s)=>sum+s.paragraphs.length,0)>200)throw new ResumeFormatError('The guide is too large to export safely. Shorten the saved guide; no content was discarded.');
  assertComplexScriptBudget(document);return document;
}
const escape=(value:unknown)=>clean(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function prepHtml(document:PrepDocument){return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(document.title)}</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:32px auto;padding:0 22px;color:#173d34}h1{line-height:1.25}section{border-top:1px solid #cad8d0;padding:16px 0}p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#14664c}footer{font-size:13px;color:#52645b}</style><h1>${escape(document.title)}</h1><p>${escape(document.subtitle)}</p>${document.sections.map(section=>`<section><h2>${escape(section.title)}</h2>${section.paragraphs.map(p=>`<p>${p.url?`<a href="${escape(p.url)}" target="_blank" rel="noopener noreferrer">${escape(p.text)}</a>`:escape(p.text)}</p>`).join('')}</section>`).join('')}<footer>Private HireFlow study guide - immutable export v${document.version}. Generated ${escape(document.generated_at)}.</footer></html>`;}

/** Independent A4 document layout. Unicode fonts are never shared across guides. */
export function prepPdf(document:PrepDocument):Uint8Array {
  const fonts=new UnicodePdfFonts(),pages:string[][]=[[]],links:Array<Array<{url:string;x:number;y:number;width:number;size:number}>>=[[]];
  let y=790,lines=0;
  const width=(s:string,size:number,bold=false)=>fonts.split(s).reduce((sum,part)=>sum+(/^[\x20-\x7e]*$/.test(part)?Array.from(part).reduce((n,c)=>n+(bold?PREP_BOLD_WIDTHS:PREP_REGULAR_WIDTHS)[c.charCodeAt(0)-32],0)*size/1000:fonts.measure(part,size)),0);
  const draw=(s:string,x:number,baseline:number,size:number,bold=false,muted=false)=>{let cursor=x;return fonts.split(s).map(part=>{const out=/^[\x20-\x7e]*$/.test(part)?`BT /${bold?'F2':'F1'} ${size} Tf ${muted?'0.32 0.36 0.40':'0.10 0.13 0.17'} rg 1 0 0 1 ${Number(cursor.toFixed(2))} ${Number(baseline.toFixed(2))} Tm (${pdfLiteral(part)}) Tj ET`:fonts.draw(part,cursor,baseline,size,bold,muted);cursor+=width(part,size,bold);return out;}).join('\n');};
  const ensure=(height:number)=>{if(y-height>=55)return;pages.push([]);links.push([]);y=790;pages.at(-1)!.push(draw('HireFlow - private interview guide (continued)',48,y,9,true,true));y-=24;};
  const wrap=(text:string,size:number,bold=false)=>{
    const out:string[]=[];for(const paragraph of clean(text).split('\n')){let line='';for(const word of paragraph.split(/\s+/).filter(Boolean)){
      if(line&&width(line+' '+word,size,bold)>499){out.push(line);line='';}
      if(width(word,size,bold)>499){let part='';for(const {segment}of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(word)){if(part&&width(part+segment,size,bold)>499){out.push(part);part='';}part+=segment;}line=part;}else line+=(line?' ':'')+word;
    }if(line)out.push(line);}return out;
  };
  const paragraph=(text:string,size=10.2,bold=false,url?:string)=>{
    const wrapped=wrap(text,size,bold);if((lines+=wrapped.length)>1000)throw new ResumeFormatError('The guide needs too many pages to export safely. Shorten the saved guide; no content was discarded.');
    ensure(Math.min(wrapped.length,2)*15);for(const line of wrapped){ensure(15);pages.at(-1)!.push(draw(line,48,y,size,bold));if(url)links.at(-1)!.push({url,x:48,y,width:Math.min(499,width(line,size)),size});y-=size>18?28:15;}y-=5;
  };
  paragraph(document.title,22,true);paragraph(document.subtitle,12);
  for(const section of document.sections){ensure(65);y-=10;paragraph(section.title,12,true);for(const item of section.paragraphs)paragraph(item.text,10.2,false,item.url);}
  pages.forEach((commands,index)=>commands.push(draw(`HireFlow - guide v${document.version} | ${index+1} / ${pages.length}`,48,30,8,false,true)));
  const objects:string[]=[],add=(body:string)=>{objects.push(body);return objects.length;},catalog=add(''),tree=add(''),regular=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),boldFont=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),fontRefs=`/F1 ${regular} 0 R /F2 ${boldFont} 0 R `+Object.entries(fonts.embed(add)).map(([name,id])=>`/${name} ${id} 0 R`).join(' ');
  const literal=(s:string)=>s.replace(/([\\()])/g,'\\$1'),num=(n:number)=>Number(n.toFixed(2));
  const pageRefs=pages.map((commands,index)=>{const stream=commands.join('\n'),content=add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);const annotations=links[index].map(link=>add(`<< /Type /Annot /Subtype /Link /Rect [${num(link.x)} ${num(link.y-2)} ${num(link.x+link.width)} ${num(link.y+link.size+2)}] /Border [0 0 0] /A << /S /URI /URI (${literal(link.url)}) >> >>`));return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fontRefs} >> >> /Contents ${content} 0 R${annotations.length?` /Annots [${annotations.map(id=>`${id} 0 R`).join(' ')}]`:''} >>`);});
  objects[catalog-1]=`<< /Type /Catalog /Pages ${tree} 0 R >>`;objects[tree-1]=`<< /Type /Pages /Kids [${pageRefs.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((body,index)=>{offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${body}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes=new TextEncoder().encode(pdf);if(bytes.length>2*1024*1024)throw new ResumeFormatError('The guide PDF exceeds the private export size limit. Shorten the saved guide.');return bytes;
}
