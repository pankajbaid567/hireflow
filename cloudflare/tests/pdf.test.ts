import { describe, expect, it } from 'vitest';
import { createResume, textPdf } from '../src/pdf';

function document(bytes: Uint8Array) {
  const pdf = new TextDecoder().decode(bytes);
  expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
  const trailer = /startxref\n(\d+)\n%%EOF\n$/.exec(pdf);
  expect(trailer).not.toBeNull();
  const offset = Number(trailer![1]);
  expect(pdf.slice(offset, offset + 5)).toBe('xref\n');
  const crossReferences = pdf.slice(offset).split('\n');
  const size = Number(crossReferences[1].split(' ')[1]);
  expect(crossReferences[2]).toBe('0000000000 65535 f ');
  // A PDF reader resolves objects through byte offsets, so validating headers
  // alone would miss corruption caused by non-ASCII text or bad escaping.
  for (let objectId = 1; objectId < size; objectId++) {
    const entry = crossReferences[objectId + 2];
    expect(entry).toMatch(/^\d{10} 00000 n $/);
    expect(pdf.slice(Number(entry.slice(0, 10)))).toMatch(new RegExp(`^${objectId} 0 obj\\n`));
  }
  for (const stream of pdf.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const contentStart = stream.index! + stream[0].length;
    expect(pdf.slice(contentStart + Number(stream[1]))).toMatch(/^\nendstream/);
  }
  const pages = Array.from(pdf.matchAll(/\/Type \/Page\b/g)).length;
  expect(pdf).toContain(`/Count ${pages}`);
  const text = Array.from(pdf.matchAll(/\/ActualText <FEFF([0-9A-F]+)>|\(((?:\\.|[^\\)])*)\) Tj/g))
    .map(match => match[1] ? String.fromCharCode(...(match[1].match(/.{4}/g)||[]).map(value=>parseInt(value,16))) : match[2].replace(/\\([\\()])/g, '$1')).join('\n');
  return { pdf, text, pages };
}

describe('lightweight ATS resume PDFs', () => {
  it('produces a valid, readable empty one-page PDF', () => {
    const output = document(textPdf([]));
    expect(output.pages).toBe(1);
    expect(output.text).toBe('');
  });

  it('preserves profile facts and highlights actual matched skills without inventing JD skills', () => {
    const profile = {
      name: 'Test Student', email: 'student@example.com', phone: '9999999999',
      skills: ['SQL', 'Python', 'FastAPI'], summary: 'Built a Python project for a college course.',
      experience: [{ title: 'Student Developer', company: 'College Club', bullets: ['Created a Python API'] }],
      projects: [{ name: 'Course API', tech: ['Python', 'FastAPI'], description: 'A course project.' }],
      education: [{ degree: 'BTech', college: 'NST Engineering', year: '2027' }],
    };
    const output = document(createResume(profile, { title: 'AI Engineer Intern', company: 'AIBridge', description: 'Python and Docker required' }, ['python']));
    expect(output.text).toContain('Test Student');
    expect(output.text).toContain('student@example.com | 9999999999');
    expect(output.text).not.toContain('APPLICATION:');
    expect(output.text).not.toContain('AIBridge');
    expect(output.pdf).toContain('/BaseFont /Helvetica-Bold');
    expect(output.text).toContain('Python, SQL, FastAPI');
    for (const fact of ['Student Developer', 'College Club', 'Created a Python API', 'Course API', 'NST Engineering', 'BTech', '2027']) expect(output.text).toContain(fact);
    expect(output.text).not.toContain('Docker');
    expect(profile.skills).toEqual(['SQL', 'Python', 'FastAPI']);
  });

  it('escapes PDF literal delimiters and preserves accented letters and normalizes common punctuation without corrupting offsets', () => {
    const name = "Zoe (Student) \\ Developer";
    const output = document(createResume({ name, skills: ['Python'], summary: 'Zoë’s résumé — API project' }, { title: 'Intern', company: 'Acme (Research)' }, []));
    expect(output.text).toContain(name);
    expect(output.text.replace(/\s+/g, " ")).toContain("Zoë's résumé - API project");
    expect(output.pdf).toContain('Zoe \\(Student\\) \\\\ Developer');
    expect(output.pages).toBe(1);
  });

  it('retains original uploaded history when structured experience is unavailable', () => {
    const output = document(createResume({ name: 'Student', skills: ['Python'], experience: [], resume_text: 'Volunteered for the college robotics team.' }, { title: 'Intern', company: 'Local Demo' }, []));
    expect(output.text).toContain('ADDITIONAL EXPERIENCE');
    expect(output.text).toContain('Volunteered for the college robotics team.');
  });

  it('uses structured experience without duplicating the original resume', () => {
    const output = document(createResume({ name: 'Student', skills: ['Python'], experience: [{ title: 'Volunteer', bullets: ['Built an API'] }], resume_text: 'Original resume should not be duplicated.' }, { title: 'Intern', company: 'Local Demo' }, []));
    expect(output.text).toContain('Volunteer');
    expect(output.text).toContain('Built an API');
    expect(output.text).not.toContain('Original resume should not be duplicated.');
  });

  it('retains the first and last lines across multiple pages with valid cross references', () => {
    const output = document(textPdf(Array.from({ length: 120 }, (_, index) => `Experience line ${index}`)));
    expect(output.pages).toBeGreaterThan(1);
    expect(output.text).toContain('Experience line 0');
    expect(output.text).toContain('Experience line 119');
  });

  it('omits empty sections and never invents professional experience for a student', () => {
    const output = document(createResume({ name: 'Student', email: 'student@example.com', skills: ['Python'], experience_years: 0, experience: [], projects: [{ name: '', description: '' }], education: [] }, { title: 'Senior Engineer', company: 'Employer' }, []));
    expect(output.text).toContain('SKILLS');
    for (const absent of ['EXPERIENCE', 'PROJECTS', 'EDUCATION', 'years of professional experience', 'Senior Engineer', 'Employer']) expect(output.text).not.toContain(absent);
    expect(output.pages).toBe(1);
  });

  it('preserves complete project, education, experience, date, and link facts across common schemas', () => {
    const output = document(createResume({
      name: 'Student', skills: ['Python'],
      experience: [{ role: 'Research Intern', employer: 'Lab', start_date: 'May 2025', end_date: 'Aug 2025', location: 'Pune', details: ['Tested 42 retrieval cases', 'Recorded evaluation results'], certificate: 'Verified internship letter' }],
      projects: [{ title: 'Accessible Archive', technologies: ['Python', 'SQL'], description: 'A searchable course archive.', bullets: ['Indexed 300 course documents'], github: 'https://github.com/student/archive', outcome: 'Used by the college club' }],
      education: { qualification: 'BTech Computer Science', university: 'Example University', graduation_year: '2027', cgpa: '8.6/10' },
    }, {}, []));
    for (const fact of ['Research Intern', 'Lab', 'May 2025 - Aug 2025', 'Pune', 'Tested 42 retrieval cases', 'Recorded evaluation results', 'Verified internship letter', 'Accessible Archive', 'Python, SQL', 'A searchable course archive.', 'Indexed 300 course documents', 'https://github.com/student/archive', 'Used by the college club', 'BTech Computer Science', 'Example University', '2027', '8.6/10']) expect(output.text).toContain(fact);
  });

  it('wraps long text and URLs within margins without losing their final characters', () => {
    const url = `https://example.com/${'long-project-reference-'.repeat(15)}final`;
    const output = document(createResume({ name: 'Student', projects: [{ name: 'Project', description: 'A detailed project with a preserved ending. '.repeat(12), url }] }, {}, []));
    expect(output.text.replace(/\s/g, '')).toContain(url);
    expect(output.text).toContain('preserved ending.');
    const positions = [...output.pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(positions.every(([x, y]) => x >= 48 && x <= 547 && y >= 54 && y <= 801)).toBe(true);
  });

  it('flows a fuller history across two pages without dropping facts or orphaning headings', () => {
    const experience = Array.from({ length: 3 }, (_, index) => ({ title: `Software Engineer ${index}`, company: `Team ${index}`, dates: '2022 - 2025', bullets: Array.from({ length: 5 }, (_, bullet) => `Delivered project ${index}.${bullet} with Python and automated integration testing, documented design choices and reviewed outcomes with the team.`) }));
    const output = document(createResume({ name: 'Experienced Candidate', email: 'candidate@example.com', summary: 'Software engineer with experience building APIs and reliable data workflows.', skills: ['Python', 'SQL', 'TypeScript'], experience, education: [{ degree: 'BSc Computer Science', institution: 'Example University', year: '2022' }] }, {}, []));
    expect(output.pages).toBe(2); expect(output.text).toContain('Delivered project 2.4'); expect(output.text).toContain('Example University');
    for (const stream of output.pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
      const lines = [...stream[1].matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(match => match[1]);
      expect(['SUMMARY', 'SKILLS', 'EXPERIENCE', 'PROJECTS', 'EDUCATION']).not.toContain(lines.at(-1));
    }
  });

  it('retains the textPdf whitespace contract used by large provider probes', () => {
    expect(textPdf(['Student', ...Array(300).fill(' '.repeat(120))]).byteLength).toBeGreaterThan(32768);
  });
  it('includes supplied links, certifications, achievements and languages without adding placeholders', () => {
    const output = document(createResume({ name: 'Student', links: [{ label: 'Portfolio', url: 'https://student.example.com' }], certifications: ['Cloud Fundamentals, 2025'], achievements: ['Won a college hackathon'], languages: ['English', 'Hindi'], projects: [{ name: 'Project', github: 'https://github.com/student/project', live: 'https://project.example.com' }] }, {}, []));
    for (const fact of ['https://student.example.com', 'Cloud Fundamentals, 2025', 'Won a college hackathon', 'English, Hindi', 'https://github.com/student/project', 'https://project.example.com']) expect(output.text).toContain(fact);
    for (const section of ['CERTIFICATIONS', 'ACHIEVEMENTS', 'LANGUAGES']) expect(output.text).toContain(section);
    expect(output.pdf).toContain('/Subtype /Link'); expect(output.pdf).toContain('/URI (https://project.example.com)');
  });
  it('prioritizes existing projects that use matched skills without rewriting their facts', () => {
    const output = document(createResume({ name: 'Student', projects: [{ name: 'Interface Project', tech: ['React'], description: 'Built a course interface.' }, { name: 'Data Project', tech: ['Python'], description: 'Processed course data.' }] }, { title: 'Python role' }, ['Python']));
    expect(output.text.indexOf('Data Project')).toBeLessThan(output.text.indexOf('Interface Project'));
    expect(output.text).toContain('Built a course interface.'); expect(output.text).toContain('Processed course data.');
  });
});
