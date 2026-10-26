/** Publish from the frontend project so Pages Functions accompany its assets. */
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),frontend=root+'frontend/';
async function smallJson(response){
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw new Error('The published API returned non-JSON content; a static SPA fallback is not a working API proxy.');
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(!reader)throw new Error('The published API returned an empty response.');
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192)throw new Error('The published API smoke response exceeds its bound.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('The published API did not return valid JSON.');}
}
export async function verifyPublishedAPI(base='https://hireflow-dashboard.pages.dev',fetcher=fetch){
  const health=await fetcher(base+'/api/health',{redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(health.status,200,'Published API health must be HTTP 200.');
  const body=await smallJson(health);assert.equal(body.status,'ok');assert.equal(body.runtime,'cloudflare-workers');
  // An invalid profile must reach backend validation without creating a user.
  // This also detects a missing/wrong server-only proxy credential.
  const invalid=await fetcher(base+'/api/profile',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Origin:base},body:'{}',signal:AbortSignal.timeout(15000)});
  assert.equal(invalid.status,422,'Invalid profile must reach backend validation (HTTP 422), not a static 405 or credential failure.');
  const validation=await smallJson(invalid);assert.ok(validation.detail,'Backend validation detail is missing.');
  return{site:base,health_json:true,api_runtime:body.runtime,invalid_profile_status:invalid.status,real_profiles_created:0};
}
async function main(){
  assert.ok(Number(process.versions.node.split('.')[0])>=22,'Use Node 22+ with pinned Wrangler.');
  const args=process.argv.slice(2);assert.ok(args.includes('--run-deploy')||args.includes('--verify-only')||args.includes('--check-build'),'Use npm run deploy:cloudflare from frontend, or pass --verify-only.');
  assert.ok(existsSync(frontend+'dist/index.html'),'Build the Cloudflare frontend first.');
  assert.ok(existsSync(frontend+'functions/api/[[path]].js'),'Pages API Functions are missing.');
  assert.equal(JSON.parse(readFileSync(root+'cloudflare/package.json','utf8')).devDependencies.wrangler,'4.151.3');
  if(args.includes('--check-build')){console.log(JSON.stringify({frontend_build:true,pages_functions:true,publish_cwd:frontend}));return;}
  if(args.includes('--run-deploy')){
    await new Promise((resolveDone,reject)=>{const child=spawn(process.execPath,[root+'cloudflare/node_modules/wrangler/bin/wrangler.js','pages','deploy','dist','--project-name','hireflow-dashboard','--branch','main'],{cwd:frontend,env:process.env,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolveDone():reject(new Error('Pages deployment failed.')));});
  }
  console.log(JSON.stringify(await verifyPublishedAPI()));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
