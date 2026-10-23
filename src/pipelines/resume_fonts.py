"""Licensed text fonts and logical-text preservation for resume PDFs.

The bundled fonts cover Latin/Greek/Cyrillic and Devanagari. Other scripts fail
visibly instead of being replaced by boxes or silently removed.
"""
from __future__ import annotations
from functools import lru_cache
from pathlib import Path
import re, unicodedata
from xml.sax.saxutils import escape, quoteattr
from urllib.parse import urlsplit, urlunsplit, quote
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph

ASSETS=Path(__file__).resolve().parents[2]/'assets/fonts'
SANS='HireFlowSans'
DEVANAGARI='HireFlowDevanagari'
_SCRIPT=re.compile(r'([\u0900-\u097f\u1cd0-\u1cff\u200c\u200d\ua8e0-\ua8ff]+)')
_CONTROL=re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]')

@lru_cache(maxsize=1)
def register_resume_fonts():
    for name in (SANS,DEVANAGARI):
        font=TTFont(name,str(ASSETS/f'{name}-Regular.ttf'),shapable=True)
        if not font.shapable:
            raise ValueError('Install the configured uharfbuzz dependency before formatting complex-script resumes.')
        pdfmetrics.registerFont(font)
        pdfmetrics.registerFontFamily(name,normal=name,bold=name,italic=name,boldItalic=name)

def plain(value):
    return _CONTROL.sub('',unicodedata.normalize('NFC',str(value or ''))).replace('\r\n','\n').replace('\r','\n')

def text_markup(value):
    register_resume_fonts();value=plain(value)
    # Keep each Hindi paragraph in one font. ReportLab's experimental shaping
    # across interleaved font fragments can lose visual spaces, while this font
    # includes the ASCII needed for bilingual technical resumes and numbers.
    name=DEVANAGARI if _SCRIPT.search(value) else SANS
    metrics=pdfmetrics.getFont(name).face.charToGlyph
    if any(ord(char) not in metrics and char not in '\n\t\u200c\u200d' for char in value):
        raise ValueError('This resume contains a script or mixed-script symbol the automatic PDF fonts do not support. Use the original PDF; no facts were removed.')
    safe=escape(value).replace('\n','<br/>').replace('\t',' ')
    return f'<font name="{name}">{safe}</font>' if name==DEVANAGARI else safe

def safe_link(value):
    try:
        parts=urlsplit(str(value))
        if parts.scheme not in ('https','http') or not parts.hostname or parts.username or parts.password:return None
        host=parts.hostname.encode('idna').decode('ascii')
        if parts.port:host+=f':{parts.port}'
        return urlunsplit((parts.scheme,host,quote(parts.path,safe='/%:@+'),quote(parts.query,safe='=&%:@+/?'),quote(parts.fragment,safe='/%:@+?')))
    except (ValueError,UnicodeError):return None

def linked_markup(value):
    value=plain(value);parts=[];end=0
    for match in re.finditer(r'https?://[^\s|]+',value):
        parts.append(text_markup(value[end:match.start()]))
        raw=match.group(0);url=safe_link(raw)
        parts.append(f'<link href={quoteattr(url)} color="#304a58">{text_markup(raw)}</link>' if url else text_markup(raw))
        end=match.end()
    parts.append(text_markup(value[end:]));return ''.join(parts)

class LogicalTextParagraph(Paragraph):
    """Draw shaped glyphs and retain their original logical text for PDF readers.

    Poppler/PDFium honor ActualText for reordered matras and conjuncts. Python
    intake also reads it explicitly rather than treating shaped glyph order as
    the source resume text. Split fragments keep ReportLab's own text mapping.
    """
    def __init__(self,text,style,logical_text=None,**kwargs):
        self.logical_text=logical_text
        super().__init__(text,style,**kwargs)
    def draw(self):
        if self.logical_text:
            encoded=('\ufeff'+plain(self.logical_text)).encode('utf-16-be').hex().upper()
            self.canv._code.append(f'/Span << /ActualText <{encoded}> >> BDC')
        try:super().draw()
        finally:
            if self.logical_text:self.canv._code.append('EMC')
