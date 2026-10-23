import {afterAll,describe,expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createResume,textPdf,ResumeFormatError} from '../src/pdf';
import {createDocumentShaper} from '../src/resume_unicode';
import {DEVANAGARI_FONT} from '../src/resume_font_data';
import {create} from 'fontkit';
import {Buffer} from 'node:buffer';
const corpus=JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/pdf_quality/profiles.json',import.meta.url)),'utf8'));
const directory=mkdtempSync(join(tmpdir(),'hireflow-pdf-readers-'));
const reader=spawnSync('pdftotext',['-v'],{stdio:'ignore'}).status===0;
if(process.env.CI&&!reader)throw new Error('Install poppler-utils to run the real PDF reader regressions in CI.');
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
const normalized=(value:string)=>value.normalize('NFC').replace(/\s+/g,'').replace(/[‘’]/g,"'");
function read(bytes:Uint8Array,id:string){const path=join(directory,`${id}.pdf`);writeFileSync(path,bytes);return execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});}

describe.skipIf(!reader)('real PDF reader fact and Unicode coverage',()=>{
  for(const fixture of corpus.cases)it(`retains complete facts through Poppler: ${fixture.id}`,()=>{
    const original=JSON.stringify(fixture.profile),bytes=createResume(fixture.profile,{},['Python']);
    const output=read(bytes,fixture.id);
    for(const fact of fixture.expected_facts)expect(normalized(output),fact).toContain(normalized(fact));
    for(const fact of fixture.forbidden_facts)expect(normalized(output)).not.toContain(normalized(fact));
    expect(JSON.stringify(fixture.profile)).toBe(original);
    expect(bytes.byteLength).toBeLessThan(1_200_000);
    const raw=new TextDecoder().decode(bytes);for(const url of fixture.expected_urls||[])expect(raw).toContain(`/URI (${url})`);
  });
  it('keeps ordered Unicode fixture text readable without corrupting xrefs',()=>{
    const lines=['Zoë Example','किरण शर्मा','₹15,000/month'];const output=read(textPdf(lines),'unicode-text');
    for(const line of lines)expect(normalized(output)).toContain(normalized(line));
    expect(output.indexOf('Zoë')).toBeLessThan(output.indexOf('किरण'));
  });
  it('preserves grapheme clusters when a complex-script identifier wraps',()=>{
    const name='प्रौद्योगिकी'.repeat(18);const output=read(createResume({name,email:'long-name@example.com'}, {},[]),'long-hindi');
    expect(normalized(output)).toContain(normalized(name));
  });
});

describe('visible unsupported rendering states',()=>{
  it('refuses unsupported scripts rather than erasing the candidate name',()=>{
    expect(()=>createResume({name:'東京 太郎',skills:['Python']},{},[])).toThrow(ResumeFormatError);
    expect(()=>createResume({name:'Emoji 😀'},{},[])).toThrow(/script or symbol/);
    expect(()=>createResume({name:'श'.repeat(385)},{},[])).toThrow(/384 complex-script/);
  });
  it('does not include URL credentials or execute arbitrary URI schemes',()=>{
    const bytes=createResume({name:'Links',links:[{url:'https://user:password@example.com/private'},{url:'javascript:alert(1)'}]}, {},[]);
    const output=new TextDecoder().decode(bytes);expect(output).not.toContain('/URI (https://user:password@');expect(output).not.toContain('/URI (javascript:');
  });
});


describe('fontkit document state isolation',()=>{
  it('shares static tables while retaining no user glyph runs in the isolate template',()=>{
    const template=create(Buffer.from(DEVANAGARI_FONT.data,'base64'));template.layout('शिक्षा');
    const snapshot=()=>Object.values(Reflect.get(template,'_glyphs') as Record<string,{id:number;codePoints:number[]}>).map(glyph=>({id:glyph.id,codePoints:[...glyph.codePoints]}));
    const templateGlyphs=snapshot();
    const processors=Reflect.get(template._layoutEngine as object,'engine');
    const originalSequence=processors.GSUBProcessor.glyphs.map((glyph:{id:number})=>glyph.id);
    const first=createDocumentShaper(template),second=createDocumentShaper(template);
    first.layout('आदित्य राज');second.layout('किरण शर्मा');
    expect(Object.hasOwn(first,'_glyphs')).toBe(true);expect(Object.hasOwn(second,'_glyphs')).toBe(true);
    expect(Reflect.get(first,'_glyphs')).not.toBe(Reflect.get(second,'_glyphs'));
    expect(first._layoutEngine).not.toBe(second._layoutEngine);
    expect(Reflect.get(first._layoutEngine as object,'engine').GSUBProcessor).not.toBe(processors.GSUBProcessor);
    expect(Reflect.get(first._layoutEngine as object,'engine').font).toBe(first);
    expect(Reflect.get(second._layoutEngine as object,'engine').font).toBe(second);
    expect(processors.GSUBProcessor.glyphs.map((glyph:{id:number})=>glyph.id)).toEqual(originalSequence);
    expect(snapshot()).toEqual(templateGlyphs);
  });
});
