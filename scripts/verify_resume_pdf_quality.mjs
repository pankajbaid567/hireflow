/** Offline real-reader PDF corpus. No API keys, model calls, employers or email. */
import {createRequire}from'node:module';import{fileURLToPath}from'node:url';import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{resolve}from'node:path';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(new URL('../cloudflare/package.json',import.meta.url));
const output=resolve(process.argv.find(arg=>arg.startsWith('--output='))?.slice(9)||'/tmp/hireflow-p1-pdf-quality');mkdirSync(output,{recursive:true,mode:0o700});
const{build}=require('esbuild');const bundle=resolve(output,'renderer.mjs');await build({entryPoints:[resolve(root,'cloudflare/src/pdf.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const{createResume}=await import(bundle);const corpus=JSON.parse(readFileSync(resolve(root,'tests/fixtures/pdf_quality/profiles.json'),'utf8'));
for(const fixture of corpus.cases)writeFileSync(resolve(output,`worker-${fixture.id}.pdf`),createResume(fixture.profile,{},['Python']),{mode:0o600});
execFileSync(resolve(root,'venv/bin/python'),[resolve(root,'scripts/verify_resume_pdf_quality.py'),'--output',output],{stdio:'inherit'});
