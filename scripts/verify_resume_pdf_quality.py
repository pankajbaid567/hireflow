"""Offline synthetic PDF proof, real Poppler readers and deterministic fact checks.

Run the .mjs companion first to include Worker outputs. No external LLM calls.
Requires the project virtualenv, Poppler and both runtimes' normal dependencies.
"""
from __future__ import annotations
import argparse, json, re, subprocess, sys, unicodedata
from pathlib import Path
from xml.etree import ElementTree as ET
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from pypdf import PdfReader
from src.pipelines.resume_service import ResumeService
from src.utils.pdf_text import extract_resume_text

def normalized(value):return re.sub(r'\s+','',unicodedata.normalize('NFC',value)).replace('’',"'").replace('‘',"'")
def run(output):
    output.mkdir(parents=True,exist_ok=True)
    cases=json.loads((ROOT/'tests/fixtures/pdf_quality/profiles.json').read_text())['cases'];results=[]
    for case in cases:
        ResumeService._render(output/f"python-{case['id']}.pdf",case['profile'])
        for runtime in ['python','worker']:
            path=output/f"{runtime}-{case['id']}.pdf"
            if not path.exists():continue
            data=path.read_bytes();reader=PdfReader(path);pages=len(reader.pages)
            extracted=subprocess.check_output(['pdftotext','-layout',str(path),'-'],text=True)
            logical=extract_resume_text(data)
            missing=[fact for fact in case['expected_facts'] if normalized(fact) not in normalized(extracted)]
            missing_intake=[fact for fact in case['expected_facts'] if normalized(fact) not in normalized(logical)]
            fabricated=[fact for fact in case['forbidden_facts'] if normalized(fact) in normalized(extracted)]
            urls=[]
            for page in reader.pages:
                for ref in page.get('/Annots',[]):
                    annot=ref.get_object();url=annot.get('/A',{}).get('/URI')
                    if url:urls.append(str(url))
            missing_urls=[url for url in case.get('expected_urls',[]) if url not in urls]
            bbox=output/f"{runtime}-{case['id']}-bbox.html";subprocess.run(['pdftotext','-bbox',str(path),str(bbox)],check=True)
            tree=ET.parse(bbox);outside=[]
            for page in tree.getroot().iter('{http://www.w3.org/1999/xhtml}page'):
                width=float(page.attrib['width']);height=float(page.attrib['height'])
                for word in page.iter('{http://www.w3.org/1999/xhtml}word'):
                    a=word.attrib
                    if float(a['xMin'])<40 or float(a['xMax'])>width-38 or float(a['yMin'])<20 or float(a['yMax'])>height-15:outside.append(word.text)
            # Render every page; a separate recorded visual review checks layout.
            subprocess.run(['pdftoppm','-scale-to','1200','-png',str(path),str(output/f'{runtime}-{case["id"]}')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            result={'id':case['id'],'runtime':runtime,'pages':pages,'bytes':len(data),'missing_facts':missing,'missing_intake_facts':missing_intake,'invented_facts':fabricated,'missing_urls':missing_urls,'out_of_bounds_words':outside,'png_pages_rendered':pages,'passed':not(missing or missing_intake or fabricated or missing_urls or outside) and case['min_pages']<=pages<=case['max_pages']}
            results.append(result)
    proof={'status':'passed' if all(result['passed'] for result in results) else 'failed','scope':'offline synthetic text-based PDF fact/layout/reader checks; no model quality or OCR claim','cases':results,'real_provider_calls':0,'visual_review':'pending explicit PNG inspection; no independent human review claimed','artifacts':str(output)}
    (output/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n');print(json.dumps(proof,ensure_ascii=False,indent=2))
    return proof['status']=='passed'
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=Path('/tmp/hireflow-p1-pdf-quality'));args=parser.parse_args();raise SystemExit(0 if run(args.output) else 1)
