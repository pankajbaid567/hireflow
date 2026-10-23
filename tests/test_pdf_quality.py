"""Real text-PDF readers, factual preservation and supported-script boundaries."""
from copy import deepcopy
from io import BytesIO
import base64
from reportlab.lib.utils import ImageReader
import json,re,unicodedata
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest
from fastapi import HTTPException
from pypdf import PdfReader,PdfWriter
from reportlab.pdfgen.canvas import Canvas
from src.pipelines.resume_service import ResumeService
from src.pipelines.pdf_generator import PDFGenerator,_escape_latex
from src.utils.pdf_text import extract_resume_text
from src.api.routes.profile import _extract_pdf_text
CORPUS=json.loads((Path(__file__).parent/'fixtures/pdf_quality/profiles.json').read_text())['cases']

def compact(value):return re.sub(r'\s+','',unicodedata.normalize('NFC',value)).replace('’',"'")

@pytest.mark.parametrize('case',CORPUS,ids=lambda case:case['id'])
def test_actual_reportlab_render_and_intake_preserve_source_facts(tmp_path,case):
    original=deepcopy(case['profile']);path=tmp_path/f"{case['id']}.pdf";ResumeService._render(path,case['profile'])
    data=path.read_bytes();reader=PdfReader(BytesIO(data));text=_extract_pdf_text(data)
    assert case['min_pages']<=len(reader.pages)<=case['max_pages']
    for fact in case['expected_facts']:assert compact(fact) in compact(text),fact
    for fact in case['forbidden_facts']:assert compact(fact) not in compact(text)
    urls=[str(ref.get_object().get('/A',{}).get('/URI','')) for page in reader.pages for ref in page.get('/Annots',[])]
    assert all(url in urls for url in case.get('expected_urls',[]))
    assert case['profile']==original


def test_multicolumn_text_intake_keeps_both_columns_and_bottom_facts():
    output=BytesIO();canvas=Canvas(output,pagesize=(595,842));canvas.setFont('Helvetica',12)
    for index,line in enumerate(['Two Column QA','columns@example.com','Python, SQL','BTech Example College 2027']):canvas.drawString(42,795-index*24,line)
    for index,line in enumerate(['PROJECTS','Course Retrieval API','Indexed 42 supplied notes','Last verified bottom fact']):canvas.drawString(310,795-index*24,line)
    canvas.save();text=_extract_pdf_text(output.getvalue())
    for fact in ['Two Column QA','columns@example.com','Python, SQL','Course Retrieval API','Indexed 42 supplied notes','Last verified bottom fact']:assert fact in text


def test_image_only_pdf_never_becomes_an_empty_extracted_profile():
    output=BytesIO();canvas=Canvas(output);pixel=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');canvas.drawImage(ImageReader(BytesIO(pixel)),30,30,width=400,height=600);canvas.save()
    assert PdfReader(BytesIO(output.getvalue())).pages[0]['/Resources']['/XObject']
    assert extract_resume_text(output.getvalue())==''
    with pytest.raises(HTTPException,match='No readable text'):_extract_pdf_text(output.getvalue())


def test_encrypted_and_excessive_page_pdfs_fail_cleanly():
    writer=PdfWriter();writer.add_blank_page(width=595,height=842);writer.encrypt('fixture-only');output=BytesIO();writer.write(output)
    with pytest.raises(HTTPException,match='not a readable PDF'):_extract_pdf_text(output.getvalue())
    writer=PdfWriter()
    for _ in range(21):writer.add_blank_page(width=595,height=842)
    output=BytesIO();writer.write(output)
    with pytest.raises(HTTPException):_extract_pdf_text(output.getvalue())


def test_unsupported_script_fails_without_silently_emptying_a_name(tmp_path):
    path=tmp_path/'unsupported.pdf'
    with pytest.raises(ValueError,match='script'):
        ResumeService._render(path,{'name':'東京 太郎','skills':['Python']})
    assert not path.exists()


def test_legacy_generator_uses_actual_unicode_renderer_without_xelatex(tmp_path):
    generator=PDFGenerator(resumes_dir=tmp_path,xelatex_bin='not-installed')
    with patch('subprocess.run',side_effect=AssertionError('Unicode should use text renderer')):
        path=generator.generate('unicode_owner','hindi_job',CORPUS[2]['profile'])
    assert 'किरण शर्मा' in _extract_pdf_text(Path(path).read_bytes())


def test_latex_escaping_is_single_pass_and_url_fields_cannot_inject_commands(tmp_path):
    assert _escape_latex('\\')==r'\textbackslash{}'
    assert _escape_latex('{a}&%')==r'\{a\}\&\%'
    generator=PDFGenerator(resumes_dir=tmp_path)
    rendered=generator._render_latex({'name':'QA','linkedin':r'https://example.com/}\input{private}','github':'javascript:alert(1)'})
    assert r'\input{private}' not in rendered
    assert 'javascript:' not in rendered
    with pytest.raises(ValueError):generator.generate('../escape','job',{})


def test_optional_summary_generation_rejects_fabricated_credentials(tmp_path):
    profile={'skills':['Python'],'summary':'Built a Python course API.','projects':[{'name':'Course API','description':'Tested 42 supplied cases.'}]}
    user=SimpleNamespace(master_profile=profile,name='Truth QA',email='truth@example.com')
    app=SimpleNamespace(resume_path=None,user=user,user_id=1,job_id=1,job=SimpleNamespace(description='Python required'))
    service=ResumeService(storage_path=tmp_path,llm_client=Mock(extract=Mock(return_value={'summary':'AWS Certified Solutions Architect with 10 years of professional experience.'})))
    path=service.prepare(app,Mock());text=_extract_pdf_text(Path(path).read_bytes())
    assert 'Built a Python course API.' in text
    assert 'AWS Certified' not in text and '10 years' not in text
