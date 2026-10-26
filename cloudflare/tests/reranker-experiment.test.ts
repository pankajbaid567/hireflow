/** Offline learned ranking, split embargo and identity-feature regressions. */
import {describe,it,expect} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {FEATURE_NAMES,features,firstSentence,trainingPartition,fitPairwise,predict,ordered,rankingMetrics,type Query} from '../../evals/reranker_v1/reranker';
import {scoreMatch} from '../src/intelligence';
import {profileEmbeddingText,jobEmbeddingText} from '../src/semantic_matching';
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const config={iterations:60,learning_rate:.2,l2:.01,initial_weights:[0,0,0,0]};
function query(split:'dev'|'heldout',suffix=''):Query{return{id:split+suffix,split,group:split+suffix,mode:'internship',profileFingerprint:'profile-'+split+suffix,candidates:[3,2,1,0].map((relevance,index)=>({id:index+1,relevance,features:features(relevance/3,relevance/3,relevance/3),lexical:relevance/3,hybrid:relevance/3,jobFingerprint:split+suffix+'-job-'+index,sentenceFingerprint:split+suffix+'-sentence-'+index}))};}
describe('P3 frozen learned reranker experiment',()=>{
 it('freezes policy, corpus and genuine vector artifacts independently of fit results',()=>{
  const policyBytes=readFileSync(new URL('../../evals/reranker_v1/policy.json',import.meta.url)),policy=JSON.parse(policyBytes.toString());
  expect(hash(policyBytes)).toBe('15411534f0ac179b6e529311f6a9d884385e78033566e590d5627d9617915f45');
  expect(hash(readFileSync(new URL('../../'+policy.data.corpus_path,import.meta.url)))).toBe(policy.data.corpus_sha256);
  expect(hash(readFileSync(new URL('../../'+policy.data.vectors_path,import.meta.url)))).toBe(policy.data.vectors_sha256);
  expect(policy.features).toEqual(FEATURE_NAMES);expect(policy.fit.hyperparameter_search).toBe(false);expect(policy.adoption_gates.independent_real_relevance_validation_required).toBe(true);expect(policy.adoption_gates.automatic_production_activation).toBe(false);
 });
 it.each(['query','profile','domain'])('rejects shared %s identity across the heldout boundary',kind=>{
  const dev=query('dev'),held=query('heldout');if(kind==='query')held.id=dev.id;else if(kind==='profile')held.profileFingerprint=dev.profileFingerprint;else held.group=dev.group;
  expect(()=>trainingPartition([dev,held])).toThrow(/identity|input|domain/);
 });
 it('embargoes literal and first-sentence JD reuse without filtering heldout candidates',()=>{
  const dev=query('dev'),held=query('heldout');held.candidates[0].jobFingerprint=dev.candidates[0].jobFingerprint;held.candidates[1].sentenceFingerprint=dev.candidates[1].sentenceFingerprint;
  const result=trainingPartition([dev,held]);expect(result.training[0].candidates.map(candidate=>candidate.id)).toEqual([3,4]);expect(result.excluded.map(row=>row.reason)).toEqual(['shared_job_input','shared_first_description_sentence']);expect(result.heldout[0].candidates).toEqual(held.candidates);expect(held.candidates).toHaveLength(4);
 });
 it('drops a query with no remaining distinct grades and rejects an empty fit partition',()=>{
  const dev=query('dev'),held=query('heldout');held.candidates=dev.candidates.map(candidate=>({...candidate}));expect(()=>trainingPartition([dev,held])).toThrow('no trainable');
 });
 it('never fits heldout labels and has unchanged weights if heldout labels change',()=>{
  const dev=query('dev'),held=query('heldout'),first=fitPairwise(trainingPartition([dev,held]).training,config);
  held.candidates=held.candidates.map(candidate=>({...candidate,relevance:3-candidate.relevance}));
  expect(fitPairwise(trainingPartition([dev,held]).training,config)).toEqual(first);expect(()=>fitPairwise([held],config)).toThrow('Only development');
 });
 it('fits a deterministic pairwise objective and uses labels to improve the training margin',()=>{
  const dev=query('dev'),model=fitPairwise([dev],config);expect(model).toEqual(fitPairwise([dev],config));expect(model.final_loss).toBeLessThan(model.initial_loss);expect(predict(model,dev.candidates[0].features)).toBeGreaterThan(predict(model,dev.candidates[3].features));expect(model.pairs).toBe(6);
  const reversed={...dev,candidates:dev.candidates.map(candidate=>({...candidate,relevance:3-candidate.relevance}))};expect(predict(fitPairwise([reversed],config),dev.candidates[0].features)).toBeLessThan(predict(fitPairwise([reversed],config),dev.candidates[3].features));
 });
 it('does not learn candidate IDs as features and resolves score ties deterministically',()=>{
  const dev=query('dev'),model=fitPairwise([dev],config),renumbered={...dev,candidates:dev.candidates.map(candidate=>({...candidate,id:candidate.id+100}))};expect(fitPairwise([renumbered],config).weights).toEqual(model.weights);
  expect(ordered({...dev,candidates:[...dev.candidates].reverse()},'learned',{weights:[0,0,0,0]}).map(candidate=>candidate.id)).toEqual([1,2,3,4]);
 });
 it('computes frozen gain/relevance metrics and clean zero-relevance outcomes',()=>{
  const dev=query('dev');expect(rankingMetrics(dev.candidates)).toEqual({recall_at_1:.5,ndcg_at_1:1,recall_at_3:1,ndcg_at_3:1});expect(rankingMetrics(dev.candidates.map(candidate=>({...candidate,relevance:0})))).toEqual({recall_at_1:0,ndcg_at_1:0,recall_at_3:0,ndcg_at_3:0});
 });
 it('excludes direct personal and prestige fields from scalar and frozen-text inputs',()=>{
  const profile={name:'Candidate A',email:'a@example.com',skills:['Python'],experience_years:0,projects:[{name:'Scheduling',description:'Built appointment scheduling with Python.'}],education:[{institution:'Local college'}]},job={title:'Python Intern',description:'Use Python to coordinate clinic appointments.',company:'Example',listing_type:'internship'};
  const other={...profile,name:'Candidate B',email:'b@example.com',phone:'9999999999',age:61,gender:'female',caste:'changed',religion:'changed',disability:'changed',nationality:'changed',education:[{institution:'Prestigious college'}]};
  expect(profileEmbeddingText(other)).toBe(profileEmbeddingText(profile));expect(scoreMatch(other,job)).toEqual(scoreMatch(profile,job));expect(jobEmbeddingText({...job,employer_prestige:'famous'})).toBe(jobEmbeddingText(job));
  expect(features(scoreMatch(other,job).score,scoreMatch(other,job).technical_score,.7)).toEqual(features(scoreMatch(profile,job).score,scoreMatch(profile,job).technical_score,.7));
 });
 it('rejects nonfinite/out-of-bound features and unbounded fit requests',()=>{
  expect(()=>features(1,0,Number.NaN)).toThrow();expect(()=>features(1,2,.5)).toThrow();expect(()=>predict({weights:[0,0,0,0]},[0,0,0,2])).toThrow();expect(()=>fitPairwise([query('dev')],{...config,iterations:10001})).toThrow();
 });
 it('normalizes an actual description sentence independently of identity/title fields',()=>{
  expect(firstSentence('  Use Python to coordinate clinic appointments! Other source text.')).toBe('use python to coordinate clinic appointments');
 });
 it('reproduces the recorded model and decision with no provider credentials or model download',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'hireflow-reranker-repro-'));
  try{
   const childEnv:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test'};for(const name of Object.keys(childEnv))if(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_CODE/i.test(name))delete childEnv[name];
   const output=join(directory,'result.json'),modelPath=join(directory,'model.json'),child=spawnSync(process.execPath,[join(root,'scripts/evaluate_reranker.mjs'),'--output',output,'--model',modelPath],{cwd:root,encoding:'utf8',timeout:10000,env:childEnv});
   expect(child.status,child.stderr||child.error?.message).toBe(0);
   const result=JSON.parse(readFileSync(output,'utf8')),recorded=JSON.parse(readFileSync(new URL('../../evals/reranker_v1/results/experiment.json',import.meta.url),'utf8'));
   expect(readFileSync(modelPath,'utf8')).toBe(readFileSync(new URL('../../evals/reranker_v1/results/model.json',import.meta.url),'utf8'));
   expect(result.metrics).toEqual(recorded.metrics);expect(result.split).toEqual(recorded.split);expect(result.model_sha256).toBe(hash(readFileSync(modelPath)));expect(result.decision.state).toBe('not_adopted');expect(result.decision.production_changes).toBe(0);expect(result.cost.hosted_cost_usd).toBe(0);
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
});
