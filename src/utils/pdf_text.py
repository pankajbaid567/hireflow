"""Bounded text-based PDF intake, including marked logical Unicode text.

This does not perform OCR. Image-only pages return no text and must be handled
as unsupported intake rather than an invented empty profile.
"""
from io import BytesIO
from pypdf import PdfReader
from pypdf.generic import DictionaryObject, NameObject

MAX_PAGES=20
MAX_TEXT=100_000

def extract_resume_text(file_bytes:bytes)->str:
    if len(file_bytes)>10*1024*1024:raise ValueError('PDF exceeds the intake size limit')
    reader=PdfReader(BytesIO(file_bytes))
    if reader.is_encrypted:
        raise ValueError('Encrypted PDF resumes are not supported')
    if len(reader.pages)>MAX_PAGES:raise ValueError('PDF exceeds the resume page limit')
    result=[]
    for page in reader.pages:
        pieces=[];marks=[]
        resources=page.get('/Resources',{});resources=resources.get_object() if hasattr(resources,'get_object') else resources
        properties=resources.get('/Properties',{});properties=properties.get_object() if hasattr(properties,'get_object') else properties
        def before(operator,operands,_cm,_tm):
            if operator in (b'BDC',b'BMC'):
                value=None
                if operator==b'BDC' and len(operands)>1:
                    obj=operands[1]
                    if isinstance(obj,NameObject):obj=properties.get(obj,{})
                    if hasattr(obj,'get_object'):obj=obj.get_object()
                    if isinstance(obj,DictionaryObject):value=obj.get('/ActualText')
                if value is not None and not any(marks):
                    if isinstance(value,bytes):value=value.decode('utf-16' if value.startswith((b'\xfe\xff',b'\xff\xfe')) else 'utf-8')
                    pieces.append('\n'+str(value)+'\n')
                if len(marks)>16:raise ValueError('PDF text nesting exceeds the intake limit')
                marks.append(value is not None)
            elif operator==b'EMC' and marks:marks.pop()
        def visit(text,_cm,_tm,_font,_size):
            if text and not any(marks):pieces.append(text)
        page.extract_text(visitor_operand_before=before,visitor_text=visit)
        text=''.join(pieces)
        # Some unmarked producers never dispatch visitor text for an empty page.
        if not text.strip():text=page.extract_text() or ''
        result.append(text)
        if sum(map(len,result))>MAX_TEXT:raise ValueError('PDF extracted text exceeds the resume limit')
    return '\n'.join(result).strip()
