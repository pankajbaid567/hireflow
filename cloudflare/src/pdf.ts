// Dependency-free PDF layout with core fonts; no images, font embedding, or compression.
import type { Row } from './types';

const PAGE_WIDTH = 595, PAGE_HEIGHT = 842, MARGIN = 48, WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY = 10.2, LEADING = 14.2, BOTTOM = 54;
const REGULAR_WIDTHS = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const BOLD_WIDTHS = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
type Font = 'F1' | 'F2';
type Link = { x: number; y: number; width: number; size: number; url: string };

function clean(value: unknown): string {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[•▪●]/g, '-')
    .replace(/[^\x20-\x7e\n]/g, ' ');
}
function content(value: unknown, depth = 0): string {
  if (depth > 6 || value == null || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(item => content(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(item => content(item, depth + 1)).filter(Boolean).join(' | ');
  const text = clean(value).trim();
  return /^(?:n\/?a|none|null|undefined|not provided|not applicable)$/i.test(text) ? '' : text;
}
function width(text: string, size: number, font: Font = 'F1'): number {
  const metrics = font === 'F2' ? BOLD_WIDTHS : REGULAR_WIDTHS;
  let total = 0;
  for (let i = 0; i < text.length; i++) total += metrics[text.charCodeAt(i) - 32] || 0;
  return total * size / 1000;
}
function wrap(value: unknown, size = BODY, available = WIDTH, font: Font = 'F1'): string[] {
  const result: string[] = [];
  for (const paragraph of clean(value).split('\n')) {
    let line = '', lineWidth = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const wordWidth = width(word, size, font), space = line ? width(' ', size, font) : 0;
      if (line && lineWidth + space + wordWidth > available) { result.push(line); line = ''; lineWidth = 0; }
      // Split long URLs/identifiers without quadratic scans or clipping.
      if (wordWidth > available) {
        let part = '', partWidth = 0;
        for (const character of word) {
          const characterWidth = width(character, size, font);
          if (partWidth + characterWidth > available && part) { result.push(part); part = ''; partWidth = 0; }
          part += character; partWidth += characterWidth;
        }
        line = part; lineWidth = partWidth;
      } else {
        line += `${line ? ' ' : ''}${word}`; lineWidth += (lineWidth ? space : 0) + wordWidth;
      }
    }
    if (line) result.push(line);
  }
  return result;
}
const literal = (value: string) => clean(value).replace(/([\\()])/g, '\\$1');
const number = (value: number) => Number(value.toFixed(2));
function draw(text: string, x: number, y: number, size = BODY, font: Font = 'F1', muted = false): string {
  return `BT /${font} ${size} Tf ${muted ? '0.32 0.36 0.40' : '0.10 0.13 0.17'} rg 1 0 0 1 ${number(x)} ${number(y)} Tm (${literal(text)}) Tj ET`;
}

class ResumeLayout {
  pages: string[][] = [[]];
  private links: Link[][] = [[]];
  y = 790;
  private units = 0;
  private continuation = '';
  constructor(private name: string) {}
  private get page() { return this.pages[this.pages.length - 1]; }
  private ensure(height: number) {
    if (this.y - height >= BOTTOM) return;
    this.pages.push([draw(this.name, MARGIN, 801, 10, 'F2', true)]); this.links.push([]); this.y = 773;
    if (this.continuation) for (const line of wrap(`${this.continuation} (continued)`, 10.5, WIDTH, 'F2')) { this.page.push(draw(line, MARGIN, this.y, 10.5, 'F2')); this.y -= LEADING; }
  }
  private consume(lines: number) {
    this.units += lines;
    // Fail visibly on unreasonable payloads instead of silently truncating facts.
    if (this.units > 800) throw new Error('Resume is too long to format safely. Shorten the profile or use the original PDF.');
  }
  gap(value = 5) { this.y -= value; }
  reserve(height: number) { this.continuation = ''; this.ensure(Math.min(height, 110)); }
  keep(height: number) { this.ensure(Math.min(height, 110)); }
  paragraph(value: unknown, options: { size?: number; font?: Font; muted?: boolean; bullet?: boolean } = {}) {
    const size = options.size || BODY, font = options.font || 'F1', indent = options.bullet ? 12 : 0;
    const lines = wrap(value, size, WIDTH - indent, font); this.consume(lines.length);
    if (lines.length > 1) this.ensure(LEADING * (options.bullet && lines.length <= 5 ? lines.length : 2));
    lines.forEach((line, index) => {
      if (index > 0 && lines.length - index === 2) this.ensure(LEADING * 2);
      this.ensure(LEADING);
      if (options.bullet && !index) this.page.push(draw('-', MARGIN + 1, this.y, size));
      this.page.push(draw(line, MARGIN + indent, this.y, size, font, options.muted));
      for (const match of line.matchAll(/https?:\/\/[^\s|]+/g)) {
        const url = match[0].replace(/[.,;]+$/, '');
        this.links[this.links.length - 1].push({ url, x: MARGIN + indent + width(line.slice(0, match.index), size, font), y: this.y, width: width(url, size, font), size });
      }
      this.y -= size > 18 ? 29 : LEADING;
    });
  }
  section(title: string, followingHeight = 0) {
    this.continuation = ''; this.ensure(Math.max(90, Math.min(145, followingHeight + 35))); this.gap(12);
    this.page.push(draw(title, MARGIN, this.y, 10, 'F2'));
    this.page.push(`0.72 0.77 0.79 RG 0.55 w ${MARGIN} ${number(this.y - 6)} m ${PAGE_WIDTH - MARGIN} ${number(this.y - 6)} l S`);
    this.y -= 23;
  }
  entry(title: string, detail: string, dates = '') {
    this.continuation = ''; this.ensure(46); this.continuation = title;
    const dateWidth = width(dates, 9.3), room = dates && dateWidth < 155 ? WIDTH - dateWidth - 20 : WIDTH;
    const headings = wrap(title, 10.5, room, 'F2'); this.consume(headings.length);
    headings.forEach((line, index) => {
      this.ensure(LEADING); this.page.push(draw(line, MARGIN, this.y, 10.5, 'F2'));
      if (!index && dates && room < WIDTH) this.page.push(draw(dates, PAGE_WIDTH - MARGIN - dateWidth, this.y, 9.3, 'F1', true));
      this.y -= LEADING;
    });
    if (dates && (room === WIDTH || !headings.length)) this.paragraph(dates, { size: 9.3, muted: true });
    if (detail) this.paragraph(detail, { size: 9.7, muted: true });
  }
  finish() {
    if (this.pages.length > 1) this.pages.forEach((page, index) => {
      const label = `${index + 1} / ${this.pages.length}`;
      page.push(draw(label, PAGE_WIDTH - MARGIN - width(label, 8), 30, 8, 'F1', true));
    });
    return pdfDocument(this.pages.map(page => page.join('\n')), this.links);
  }
}

const get = (entry: Row, keys: string[]) => keys.map(key => content(entry[key])).find(Boolean) || '';
function entries(value: unknown): Array<Row | string> {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).filter(item => Boolean(content(item)));
}
function dates(entry: Row) {
  return get(entry, ['dates', 'period', 'duration', 'date', 'year', 'graduation_year']) || [get(entry, ['start_date', 'start_year', 'start']), get(entry, ['end_date', 'end_year', 'end'])].filter(Boolean).join(' - ');
}
const DATE_KEYS = ['dates', 'period', 'duration', 'date', 'year', 'graduation_year', 'start_date', 'start_year', 'start', 'end_date', 'end_year', 'end'];
function extras(entry: Row, used: string[]) {
  return Object.entries(entry).filter(([key, value]) => !used.includes(key) && !['id', 'user_id'].includes(key) && !key.startsWith('_') && Boolean(content(value))).map(([key, value]) => `${['gpa', 'cgpa'].includes(key) ? key.toUpperCase() : key.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase())}: ${content(value)}`);
}
function bulletLines(value: unknown) {
  return content(value).split('\n').filter(Boolean).flatMap(line => line.length > 260 ? line.split(/(?<=[.!?])\s+(?=[A-Z])/) : [line]);
}
function bullets(layout: ResumeLayout, value: unknown) {
  for (const line of bulletLines(value)) layout.paragraph(line.replace(/^[-*]\s+/, ''), { bullet: true });
}
const PROJECT_TITLE = ['name', 'title'], PROJECT_TECH = ['tech', 'technologies', 'stack', 'skills'];
const PROJECT_DETAIL = ['description', 'bullets', 'details', 'achievements'];
const PROJECT_LINKS = ['url', 'link', 'github', 'website', 'live', 'demo'];
function projectHeight(item: Row | string) {
  if (typeof item === 'string') return wrap(item).length * LEADING;
  let count = wrap(get(item, PROJECT_TITLE), 10.5, WIDTH, 'F2').length;
  for (const key of PROJECT_DETAIL) for (const line of bulletLines(item[key])) count += wrap(line, BODY, WIDTH - 12).length;
  const tech = get(item, PROJECT_TECH); if (tech) count += wrap(`Technologies: ${tech.replace(/\n/g, ', ')}`, 9.5).length;
  for (const link of new Set(PROJECT_LINKS.map(key => content(item[key])).filter(Boolean))) count += wrap(link, 9.2).length;
  for (const extra of extras(item, [...PROJECT_TITLE, ...PROJECT_TECH, ...PROJECT_DETAIL, ...PROJECT_LINKS, ...DATE_KEYS])) count += wrap(extra, BODY, WIDTH - 12).length;
  return count * LEADING + 8;
}

export function createResume(profile: Row, _job: Row, matched: string[]): Uint8Array {
  const name = content(profile.name), layout = new ResumeLayout(name);
  layout.paragraph(name, { size: 24, font: 'F2' });
  const contact = [profile.email, profile.phone, profile.location].map(value => content(value)).filter(Boolean).join(' | ');
  if (contact) layout.paragraph(contact, { size: 9.5, muted: true });
  const suppliedLinks = Array.isArray(profile.links) ? profile.links.map(link => {
    if (typeof link === 'string') return content(link);
    const url = get(link, ['url', 'href', 'link']);
    return url ? [content(link.label), url].filter(Boolean).join(': ') : '';
  }) : [];
  const links = [...[profile.linkedin, profile.github, profile.website, profile.portfolio].map(value => content(value)), ...suppliedLinks].filter(Boolean);
  if (links.length) layout.paragraph([...new Set(links)].join(' | '), { size: 9.2, muted: true });
  const summary = get(profile, ['summary', 'professional_summary', 'objective']);
  if (summary) { layout.section('SUMMARY'); layout.paragraph(summary); }
  const matchedSet = new Set(matched.map(value => clean(value).toLowerCase()));
  const skills = Array.isArray(profile.skills) ? [...new Set(profile.skills.map(value => content(value)).filter(Boolean))] : [];
  skills.sort((a, b) => Number(matchedSet.has(b.toLowerCase())) - Number(matchedSet.has(a.toLowerCase())));
  if (skills.length) { layout.section('SKILLS'); layout.paragraph(skills.join(', ')); }
  const experience = entries(profile.experience);
  if (experience.length) {
    layout.section('EXPERIENCE');
    for (const [index, item] of experience.entries()) {
      if (index) layout.gap(8);
      if (typeof item === 'string') { layout.paragraph(item); continue; }
      const titleKeys = ['title', 'role', 'position'], companyKeys = ['company', 'employer', 'organization'];
      const detailKeys = ['bullets', 'details', 'achievements', 'responsibilities', 'description'];
      layout.entry(get(item, titleKeys), [get(item, companyKeys), content(item.location)].filter(Boolean).join(' | '), dates(item));
      for (const key of detailKeys) bullets(layout, item[key]);
      for (const extra of extras(item, [...titleKeys, ...companyKeys, ...detailKeys, ...DATE_KEYS, 'location'])) bullets(layout, extra);
    }
  }
  const normalizedMatched = [...matchedSet].map(value => value.replace(/[^a-z0-9+#.]+/g, ' ').trim()).filter(Boolean);
  const projectScore = (item: Row | string) => {
    const text = ` ${content(item).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ')} `;
    return normalizedMatched.filter(skill => text.includes(` ${skill} `)).length;
  };
  const projects = entries(profile.projects).map(item => ({ item, score: projectScore(item) })).sort((a, b) => b.score - a.score).map(({ item }) => item);
  if (projects.length) {
    layout.section('PROJECTS', projectHeight(projects[0]));
    for (const [index, item] of projects.entries()) {
      if (index) { layout.reserve(projectHeight(item) + 8); layout.gap(8); }
      if (typeof item === 'string') { layout.paragraph(item); continue; }
      const titleKeys = PROJECT_TITLE, techKeys = PROJECT_TECH, detailKeys = PROJECT_DETAIL, linkKeys = PROJECT_LINKS;
      layout.entry(get(item, titleKeys), '', dates(item));
      for (const key of detailKeys) bullets(layout, item[key]);
      const tech = get(item, techKeys);
      const links = [...new Set(linkKeys.map(key => content(item[key])).filter(Boolean))];
      layout.keep(((tech ? wrap(`Technologies: ${tech.replace(/\n/g, ', ')}`, 9.5).length : 0) + links.reduce((sum, link) => sum + wrap(link, 9.2).length, 0)) * LEADING);
      if (tech) layout.paragraph(`Technologies: ${tech.replace(/\n/g, ', ')}`, { size: 9.5, muted: true });
      for (const link of links) layout.paragraph(link, { size: 9.2, muted: true });
      for (const extra of extras(item, [...titleKeys, ...techKeys, ...detailKeys, ...linkKeys, ...DATE_KEYS])) bullets(layout, extra);
    }
  }
  const education = entries(profile.education);
  if (education.length) {
    layout.section('EDUCATION');
    for (const [index, item] of education.entries()) {
      if (index) layout.gap(7);
      if (typeof item === 'string') { layout.paragraph(item); continue; }
      const titleKeys = ['degree', 'qualification', 'course', 'program'], institutionKeys = ['institution', 'college', 'university', 'school'];
      layout.entry(get(item, titleKeys), get(item, institutionKeys), dates(item));
      for (const extra of extras(item, [...titleKeys, ...institutionKeys, ...DATE_KEYS])) layout.paragraph(extra, { size: 9.5 });
    }
  }
  for (const [key, title] of [['certifications', 'CERTIFICATIONS'], ['achievements', 'ACHIEVEMENTS']] as const) {
    const items = entries(profile[key]);
    if (items.length) { layout.section(title); for (const item of items) bullets(layout, item); }
  }
  const languages = content(profile.languages).replace(/\n/g, ', ');
  if (languages) { layout.section('LANGUAGES'); layout.paragraph(languages); }
  if (!experience.length && content(profile.resume_text)) { layout.section('ADDITIONAL EXPERIENCE'); layout.paragraph(content(profile.resume_text)); }
  return layout.finish();
}

function pdfDocument(streams: string[], links: Link[][] = []): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(''), pagesId = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pages = streams.map((commands, index) => {
    const contentId = add(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    const annotations = (links[index] || []).map(link => add(`<< /Type /Annot /Subtype /Link /Rect [${number(link.x)} ${number(link.y - 2)} ${number(link.x + link.width)} ${number(link.y + link.size + 2)}] /Border [0 0 0] /A << /S /URI /URI (${literal(link.url)}) >> >>`));
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentId} 0 R${annotations.length ? ` /Annots [${annotations.map(id => `${id} 0 R`).join(' ')}]` : ''} >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pages.map(page => `${page} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

// Fixture/provider contract retained, including whitespace and input order.
export function textPdf(text: string[]): Uint8Array {
  const pages: string[] = [];
  for (let start = 0; start < Math.max(1, text.length); start += 53) pages.push(text.slice(start, start + 53).map((line, index) => draw(line, 45, 797 - index * 13, 10)).join('\n'));
  return pdfDocument(pages);
}
