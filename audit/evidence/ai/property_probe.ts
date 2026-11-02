/** Phase 4 deterministic property tests + pay-normalization table. Seeded PRNG; no network. */
import { scoreMatch } from '../../../cloudflare/src/intelligence';
import { parseCompensation, parseExperience, compensationFit, experienceFit } from '../../../cloudflare/src/listing_details';
import type { Row } from '../../../cloudflare/src/types';
let seed = 20261102; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const SK = ['Python', 'SQL', 'React', 'Docker', 'AWS', 'Go', 'Rust', 'Java', 'TypeScript', 'Redis', 'Kubernetes', 'FastAPI'];
const subset = (n: number) => [...SK].sort(() => rnd() - .5).slice(0, n);
const out: Row = { properties: [], pay: [], experience: [] };
const prop = (name: string, trials: number, fails: Row[]) => out.properties.push({ name, trials, failures: fails.length, examples: fails.slice(0, 2) });
const T = 2000;
let f: Row[] = [];
for (let i = 0; i < T; i++) { const p = { skills: subset(Math.floor(rnd() * 8)), experience_years: Math.floor(rnd() * 6), preferred_locations: rnd() < .5 ? ['Remote'] : [], target_roles: ['Backend Developer'] }; const j = { title: pick(['Backend Developer Intern', 'Senior Engineer', 'Data Analyst']), description: 'Requires ' + subset(Math.floor(rnd() * 6)).join(', '), location: pick(['Remote', 'Pune', '']) }; const s = scoreMatch(p, j).score; if (!(s >= 0 && s <= 1) || Number.isNaN(s)) f.push({ p, j, s }); }
prop('score in [0,1] and never NaN', T, f);
f = [];
for (let i = 0; i < T; i++) { const j = { title: 'Backend Developer Intern', description: 'Requires ' + subset(2 + Math.floor(rnd() * 4)).join(', ') }; const base = subset(Math.floor(rnd() * 5)); const p0 = { skills: base, experience_years: 0 }; const need = scoreMatch(p0, j).gaps; if (!need.length) continue; const p1 = { ...p0, skills: [...base, need[0]] }; const a = scoreMatch(p0, j).score, b = scoreMatch(p1, j).score; if (b + 1e-9 < a) f.push({ base, add: need[0], a, b }); }
prop('adding a REQUIRED skill to the profile never lowers the score (monotone)', T, f);
f = [];
for (let i = 0; i < T; i++) { const j = { title: 'Backend Developer Intern', description: 'Requires ' + subset(3).join(', ') }; const sk = subset(4); const a = scoreMatch({ skills: sk }, j), b = scoreMatch({ skills: [...sk].reverse() }, j); if (a.score !== b.score) f.push({ sk, a: a.score, b: b.score }); }
prop('profile skill order does not change the score', T, f);
f = [];
for (let i = 0; i < T; i++) { const j = { title: 'Backend Developer Intern', description: 'Requires ' + subset(3).join(', ') }; const sk = subset(4); const a = scoreMatch({ skills: sk }, j).score, b = scoreMatch({ skills: [...sk, ...sk.map(s => s.toLowerCase())] }, j).score; if (a !== b) f.push({ sk, a, b }); }
prop('duplicate / case-variant profile skills do not change the score', T, f);
f = [];
for (let i = 0; i < T; i++) { const p = { skills: subset(4) }; const j = { title: 'Intern', description: 'Requires ' + subset(3).join(', ') }; const a = JSON.stringify(scoreMatch(p, j)), b = JSON.stringify(scoreMatch(p, j)); if (a !== b) f.push({ p, j }); }
prop('deterministic: same input, same output', T, f);
f = [];
for (let i = 0; i < T; i++) { const j = { title: 'Intern', description: 'Requires ' + subset(3).join(', ') }; const noSkills = scoreMatch({ skills: [] }, j), all = scoreMatch({ skills: SK }, j); if (all.score + 1e-9 < noSkills.score) f.push({ j }); }
prop('full-vocabulary profile never scores below an empty profile', T, f);
f = [];
for (let i = 0; i < 300; i++) { const j = { title: 'Intern', description: 'x'.repeat(Math.floor(rnd() * 100000)) + ' Python' }; const t0 = performance.now(); scoreMatch({ skills: subset(5) }, j); if (performance.now() - t0 > 100) f.push({ len: j.description.length }); }
prop('scoring a ≤100 KB JD takes <100 ms (CPU budget)', 300, f);

const pay = (s: string, structured?: Row) => { const c = parseCompensation(s, structured); return c; };
const table: [string, Row][] = [
  ['Stipend: ₹15,000 per month', { currency: 'INR', monthly_minimum: 15000, monthly_maximum: 15000 }],
  ['Stipend ₹10,000 - ₹20,000 /month', { currency: 'INR', monthly_minimum: 10000, monthly_maximum: 20000 }],
  ['CTC: 6 LPA', { currency: 'INR', annual_minimum: 600000 }],
  ['Salary ₹8-12 LPA', { currency: 'INR', annual_minimum: 800000, annual_maximum: 1200000 }],
  ['Salary: 1.2 crore per annum', { currency: 'INR', annual_minimum: 12000000 }],
  ['Salary $120k per year', { currency: 'USD' }],
  ['Unpaid internship', { source: 'explicit_unpaid' }],
  ['Our funding round raised ₹50 crore', { source: 'not_disclosed' }],
  ['Pay: ₹5,00,000 per annum', { currency: 'INR', annual_minimum: 500000 }],
  ['No stipend mentioned, great learning', { source: 'not_disclosed' }],
  ['Stipend: not unpaid, ₹12000/month', { currency: 'INR', monthly_minimum: 12000 }],
  ['Salary: 25/hour', {}],
];
for (const [s, exp] of table) { const c: Row = pay(s); const miss: string[] = []; for (const [k, v] of Object.entries(exp)) if ((c as any)[k] !== v) miss.push(`${k}: expected ${JSON.stringify(v)} got ${JSON.stringify((c as any)[k])}`); out.pay.push({ input: s, parsed: { currency: c.currency, period: c.period, monthly_min: c.monthly_minimum, annual_min: c.annual_minimum, annual_max: c.annual_maximum, source: c.source }, expected_subset: exp, mismatches: miss }); }
const exps: [string, number | null][] = [['2-4 years of experience', 2], ['Freshers welcome', 0], ['Experience: 3 years', 3], ['5+ years experience', 5], ['Senior colleagues with 10 years of experience mentor you', null], ['Requires 99 years of experience', null]];
for (const [s, exp] of exps) { const e: Row | null = parseExperience(s); out.experience.push({ input: s, minimum_years: e?.minimum_years ?? null, expected: exp, ok: (e?.minimum_years ?? null) === exp }); }
// fit functions: bounded + monotone in years below requirement
let ef: Row[] = []; for (let i = 0; i < 1000; i++) { const req = { minimum_years: Math.floor(rnd() * 8), maximum_years: null }; const a = experienceFit(req, Math.floor(rnd() * 8)), b = experienceFit(req, 10); if (!(a >= 0 && a <= 1 && b >= 0 && b <= 1)) ef.push({ req, a, b }); }
prop('experienceFit in [0,1]', 1000, ef);
const fresher = { skills: ['Python', 'SQL'], experience_years: 0 };
const withMentor = scoreMatch(fresher, { title: 'Backend Developer Intern', description: 'Build APIs with Python and SQL. Our mentors have 10 years of experience and will guide you.' });
const without = scoreMatch(fresher, { title: 'Backend Developer Intern', description: 'Build APIs with Python and SQL. Our mentors will guide you.' });
out.mentor_experience_false_positive = { with_mentor_sentence: { score: withMentor.score, experience_fit: withMentor.factors.experience_fit }, without: { score: without.score, experience_fit: without.factors.experience_fit } };
console.log(JSON.stringify(out, null, 1));
