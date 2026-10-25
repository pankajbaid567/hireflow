/** Offline P2 preparation regression. No model, provider or employer requests. */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../cloudflare/package.json',import.meta.url)),{build}=require('esbuild'),directory=mkdtempSync(join(tmpdir(),'hireflow-prep-eval-'));
try{const output=join(directory,'evaluate.mjs');await build({entryPoints:[join(root,'evals/prep_v2/evaluate.ts')],bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent',target:'node22'});const result=spawnSync(process.execPath,[output,root],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;}finally{rmSync(directory,{recursive:true,force:true});}
