"""Create public synthetic resume intake layouts, without model/API calls."""
from io import BytesIO
import base64
from reportlab.lib.utils import ImageReader
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from src.pipelines.resume_service import ResumeService
import json
ROOT=Path(__file__).resolve().parents[1]

def build(output:Path):
    output.mkdir(parents=True,exist_ok=True)
    cases=json.loads((ROOT/'tests/fixtures/pdf_quality/profiles.json').read_text())['cases'];by_id={case['id']:case for case in cases}
    multi=output/'intake-multicolumn.pdf';c=canvas.Canvas(str(multi),pagesize=A4);c.setFont('Helvetica-Bold',18);c.drawString(42,793,'Two Column QA');c.setFont('Helvetica',11)
    for index,line in enumerate(['columns@example.com','SKILLS','Python, SQL','EDUCATION','BTech Example College 2027']):c.drawString(42,758-index*24,line)
    c.line(293,480,293,780)
    for index,line in enumerate(['PROJECTS','Course Retrieval API','Indexed 42 supplied notes','EXPERIENCE','Student project work only','Last verified bottom fact']):c.drawString(310,758-index*24,line)
    c.save()
    for id in ['long_history','sparse_student','latin_names','devanagari']:ResumeService._render(output/f'intake-{id}.pdf',by_id[id]['profile'])
    # An image-only/vector-only input has no selectable source text. No OCR is
    # asserted; Python intake rejects it before making any model request.
    c=canvas.Canvas(str(output/'intake-no-text.pdf'),pagesize=A4);pixel=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');c.drawImage(ImageReader(BytesIO(pixel)),40,80,width=510,height=680);c.save()
    manifest={'scope':'synthetic text-based source layouts plus explicit no-text rejection control','cases':[
        {'id':'multicolumn','file':multi.name,'critical':{'name':'Two Column QA','email':'columns@example.com','skills':['Python','SQL']},'source_facts':['Course Retrieval API','42','Example College','2027'],'live_probe':True},
        {'id':'long_history','file':'intake-long_history.pdf','critical':{'name':'Long History QA','email':'history@example.com','skills':['Python','SQL','Docker']},'source_facts':['checkpoint 0.0','checkpoint 4.6','Example University'],'live_probe':True},
        {'id':'devanagari','file':'intake-devanagari.pdf','critical':{'name':'किरण शर्मा','email':'kiran@example.com','skills':['Python','SQL']},'source_facts':['2027'],'live_probe':True},
        {'id':'sparse_student','file':'intake-sparse_student.pdf','live_probe':False},
        {'id':'latin_names','file':'intake-latin_names.pdf','live_probe':False},
        {'id':'no_text','file':'intake-no-text.pdf','live_probe':False,'expected_text_empty':True}]}
    (output/'intake-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest
