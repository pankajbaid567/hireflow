/** Bounded Unicode font support. Font files are pre-subset offline, never at request time. */
import { create, type Font } from 'fontkit';
import { Buffer } from 'node:buffer';
import { LATIN_FONT, DEVANAGARI_FONT } from './resume_font_data';

type FontKey = 'F3' | 'F4';
type FontAsset = {name:string;data:string;unitsPerEm:number;bbox:readonly number[];ascent:number;descent:number;metrics:Readonly<Record<string,readonly [number,number]>>;advances:readonly number[]};
type Glyph = {id:number;advance:number;xOffset:number;yOffset:number;codePoints:number[]};
type Run = {key:FontKey;source:string;glyphs:Glyph[];advance:number};
const assets:Record<FontKey,FontAsset>={F3:LATIN_FONT,F4:DEVANAGARI_FONT};
const devanagari=/[\u0900-\u097f\u1cd0-\u1cff\u200c\u200d\ua8e0-\ua8ff]/u;
const segments=/([\u0900-\u097f\u1cd0-\u1cff\u200c\u200d\ua8e0-\ua8ff]+|\s+)/u;
const ascii=/^[\x20-\x7e]*$/;
const hex=(value:number)=>value.toString(16).padStart(4,'0').toUpperCase();
export const utf16Hex=(value:string)=>Array.from({length:value.length},(_,i)=>hex(value.charCodeAt(i))).join('');
const rounded=(value:number)=>Number(value.toFixed(3));

// Pure font data/shaper, no request data or I/O. Warm OpenType tables during
// isolate initialization, so a first Hindi name doesn't parse them on its request.
const hindiTemplate=create(Buffer.from(DEVANAGARI_FONT.data,'base64'));
hindiTemplate.layout('किरण शर्मा शिक्षा प्रौद्योगिकी');
export function createDocumentShaper(template:Font=hindiTemplate):Font {
  // fontkit2.0.4 retains glyph runs in its processors. Share only parsed tables;
  // each document owns every glyph cache and layout/GSUB/GPOS processor.
  // The version-pinned adapter is covered by real-reader workerd regressions.
  const font:Font=Object.create(template);
  Object.defineProperty(font,'_glyphs',{value:{},writable:true});
  const Layout=template._layoutEngine.constructor;
  Object.defineProperty(font,'_layoutEngine',{value:new Layout(font),writable:true});
  return font;
}
const embedded=Object.fromEntries(Object.entries(assets).map(([key,asset])=>{
  const bytes=Buffer.from(asset.data,'base64'),fontHex=bytes.toString('hex').toUpperCase(),scale=1000/asset.unitsPerEm;
  return[key,{stream:`<< /Length ${fontHex.length+1} /Length1 ${bytes.length} /Filter /ASCIIHexDecode >>\nstream\n${fontHex}>\nendstream`,
    bbox:asset.bbox.map(n=>rounded(n*scale)).join(' '),ascent:rounded(asset.ascent*scale),descent:rounded(asset.descent*scale),
    widths:asset.advances.map((advance,id)=>`${id} [${rounded(advance*scale)}]`).join(' ')}];
})) as Record<FontKey,{stream:string;bbox:string;ascent:number;descent:number;widths:string}>;

export class ResumeFormatError extends Error {
  constructor(message:string){super(message);this.name='ResumeFormatError';}
}

export function assertComplexScriptBudget(value:unknown) {
  let count=0;
  const scan=(item:unknown,depth=0):void=>{if(depth>6||item==null)return;if(typeof item==='string'){count+=(item.match(/[\u0900-\u097f\u1cd0-\u1cff\u200c\u200d\ua8e0-\ua8ff]/gu)||[]).length;}else if(Array.isArray(item))item.forEach(value=>scan(value,depth+1));else if(typeof item==='object')Object.values(item).forEach(value=>scan(value,depth+1));};
  scan(value);if(count>384)throw new ResumeFormatError('Automatic PDF formatting supports up to 384 complex-script characters per resume. Keep the original PDF or shorten the reviewed resume; no facts were removed.');
}

export class UnicodePdfFonts {
  private used=new Map<FontKey,Map<number,string>>();
  private cache=new Map<string,Run>();
  private totalComplexCharacters=0;
  private drawnComplexCharacters=0;
  private shaper?:Font;
  split(text:string){return text.split(segments).filter(Boolean);}
  isAscii(text:string){return ascii.test(text);}
  private shape(source:string):Run {
    const cached=this.cache.get(source);if(cached)return cached;
    const key:FontKey=devanagari.test(source)?'F4':'F3',asset=assets[key];
    for(const character of source){const cp=character.codePointAt(0)!;if(!asset.metrics[String(cp)]&&!['\u200c','\u200d'].includes(character))throw new ResumeFormatError('This resume contains a script or symbol the automatic PDF fonts do not support. Keep the original PDF or use a supported text spelling; no resume facts were removed.');}
    let glyphs:Glyph[];
    if(key==='F4'){
      this.totalComplexCharacters+=source.length;
      if(this.totalComplexCharacters>1200)throw new ResumeFormatError('The complex-script content is too long for safe automatic PDF formatting. Use the original PDF or shorten the reviewed resume.');
      const shaped=(this.shaper ||= createDocumentShaper()).layout(source);
      glyphs=shaped.glyphs.map((glyph,index)=>({id:glyph.id,advance:shaped.positions[index].xAdvance,xOffset:shaped.positions[index].xOffset,yOffset:shaped.positions[index].yOffset,codePoints:glyph.codePoints}));
    }else glyphs=Array.from(source,character=>{const cp=character.codePointAt(0)!,metric=asset.metrics[String(cp)];return{id:metric[0],advance:metric[1],xOffset:0,yOffset:0,codePoints:[cp]};});
    const result={key,source,glyphs,advance:glyphs.reduce((sum,glyph)=>sum+glyph.advance,0)/asset.unitsPerEm};
    if(this.cache.size<1200)this.cache.set(source,result);
    return result;
  }
  measure(source:string,size:number){return this.shape(source).advance*size;}
  draw(source:string,x:number,y:number,size:number,bold=false,muted=false){
    const run=this.shape(source),asset=assets[run.key],scale=size/asset.unitsPerEm;
    if(run.key==='F4'){this.drawnComplexCharacters+=source.length;if(this.drawnComplexCharacters>384)throw new ResumeFormatError('The complex-script text needs too much automatic layout work. Keep the original PDF or shorten the reviewed resume; no facts were removed.');}
    let map=this.used.get(run.key);if(!map){map=new Map();this.used.set(run.key,map);}
    let cursor=x;
    const commands=[`/Span << /ActualText <FEFF${utf16Hex(source)}> >> BDC`];
    for(const glyph of run.glyphs){
      if(glyph.codePoints.length&&!map.has(glyph.id))map.set(glyph.id,glyph.codePoints.map(cp=>String.fromCodePoint(cp)).join(''));
      commands.push(`BT /${run.key} ${size} Tf ${muted?'0.32 0.36 0.40':'0.10 0.13 0.17'} rg ${bold?'0.16 w 2 Tr ':''}1 0 0 1 ${rounded(cursor+glyph.xOffset*scale)} ${rounded(y+glyph.yOffset*scale)} Tm <${hex(glyph.id)}> Tj${bold?' 0 Tr':''} ET`);
      cursor+=glyph.advance*scale;
    }
    commands.push('EMC');return commands.join('\n');
  }
  embed(add:(body:string)=>number):Record<string,number>{
    const references:Record<string,number>={};
    for(const[key,used]of this.used){
      const asset=assets[key],prepared=embedded[key];
      const file=add(prepared.stream);
      const descriptor=add(`<< /Type /FontDescriptor /FontName /${asset.name} /Flags 32 /FontBBox [${prepared.bbox}] /ItalicAngle 0 /Ascent ${prepared.ascent} /Descent ${prepared.descent} /CapHeight ${prepared.ascent} /StemV 80 /FontFile2 ${file} 0 R >>`);

      const descendant=add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${asset.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${prepared.widths}] /CIDToGIDMap /Identity >>`);
      const mappings=[...used].map(([id,value])=>`<${hex(id)}> <${utf16Hex(value)}>`);
      const blocks=[];for(let start=0;start<mappings.length;start+=100){const values=mappings.slice(start,start+100);blocks.push(`${values.length} beginbfchar\n${values.join('\n')}\nendbfchar`);}
      const cmap=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /${asset.name}-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      const cmapId=add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
      references[key]=add(`<< /Type /Font /Subtype /Type0 /BaseFont /${asset.name} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmapId} 0 R >>`);
    }
    return references;
  }
}
