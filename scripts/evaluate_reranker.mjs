/** Offline only: actual Worker feature functions + a separately versioned learner. */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../cloudflare/package.json',import.meta.url));
if(Number(process.versions.node.split('.')[0])<22)throw new Error('Use Node22+ with the project dependencies installed.');
const {build}=require('esbuild'),directory=mkdtempSync(join(tmpdir(),'hireflow-reranker-'));
try{
 const output=join(directory,'evaluate.mjs');
 await build({entryPoints:[join(root,'evals/reranker_v1/evaluate.ts')],bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent',target:'node22',external:['@cloudflare/playwright']});
 const child=spawnSync(process.execPath,[output,'--root',root,...process.argv.slice(2)],{cwd:root,stdio:'inherit',env:process.env});
 process.exitCode=child.status??1;
}finally{rmSync(directory,{recursive:true,force:true});}
