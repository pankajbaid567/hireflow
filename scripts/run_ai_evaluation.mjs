/** Bundle the repository's actual Worker functions for a deterministic Node eval.
 * No hosted provider calls occur unless --live-tailoring is explicitly passed.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../cloudflare/package.json',import.meta.url));
const {build}=require('esbuild'),directory=mkdtempSync(join(tmpdir(),'hireflow-ai-eval-'));
try{
 const output=join(directory,'evaluate.mjs');await build({entryPoints:[join(root,'evals/evaluate.ts')],bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent',target:'node22'});
 const child=spawnSync(process.execPath,[output,'--root',root,...process.argv.slice(2)],{cwd:root,stdio:'inherit',env:process.env});
 process.exitCode=child.status??1;
}finally{rmSync(directory,{recursive:true,force:true});}
