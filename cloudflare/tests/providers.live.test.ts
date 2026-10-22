import { describe, expect, it } from 'vitest';
import { extractProfile, generateText } from '../src/intelligence';
import { textPdf } from '../src/pdf';
import type { Env } from '../src/types';

// Explicit opt-in: normal CI never sends personal data or provider requests.
describe.skipIf(process.env.RUN_CLOUDFLARE_LIVE !== '1')('live Worker provider contracts',()=>{
  const base={GROQ_API_KEY:process.env.GROQ_API_KEY,GROQ_MODEL:process.env.GROQ_MODEL||'openai/gpt-oss-20b',GEMINI_API_KEY:process.env.GEMINI_API_KEY,GOOGLE_API_KEY:process.env.GOOGLE_API_KEY,GEMINI_MODEL:process.env.GEMINI_MODEL||'gemini-3.8-flash',GEMINI_FALLBACK_MODEL:process.env.GEMINI_FALLBACK_MODEL};
  it('generates a Groq answer using the configured production model',async()=>{
    const answer=await generateText({...base,LLM_PROVIDER:'groq'} as Env,'Respond with the two words: HireFlow ready');
    expect(answer.toLowerCase()).toContain('hireflow');
  },65000);
  it('generates a Gemini answer using the configured model',async()=>{
    const answer=await generateText({...base,LLM_PROVIDER:'gemini'} as Env,'Respond with the two words: HireFlow ready');
    expect(answer.toLowerCase()).toContain('hireflow');
  },65000);
  it('extracts facts from a real generated PDF through Gemini',async()=>{
    const pdf=textPdf(['Test Owner','test-owner@example.com','Python, FastAPI, LangChain','B.Tech Computer Science, Example University','One project: HireFlow career assistant','Seeking software engineering internships']);
    const profile=await extractProfile({...base,LLM_PROVIDER:'groq'} as Env,pdf);
    expect(profile.email).toBe('test-owner@example.com');expect(profile.skills).toContain('Python');
  },50000);
  it('uploads a larger PDF through Gemini Files and cleans it up',async()=>{
    const pdf=textPdf(['Test Owner','test-owner@example.com','Python, FastAPI, LangChain','B.Tech Computer Science, Example University',...Array(300).fill(' '.repeat(120))]);
    expect(pdf.length).toBeGreaterThan(32768);
    const profile=await extractProfile({...base,LLM_PROVIDER:'groq'} as Env,pdf);
    expect(profile.email).toBe('test-owner@example.com');expect(profile.skills).toContain('Python');
  },50000);
});
