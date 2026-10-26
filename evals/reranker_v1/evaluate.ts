/** Reused synthetic holdout, fixed policy. No provider or production I/O. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {scoreMatch} from '../../cloudflare/src/intelligence';
import {cosineSimilarity,hybridScore,profileEmbeddingText,jobEmbeddingText} from '../../cloudflare/src/semantic_matching';
import {FEATURE_NAMES,features,firstSentence,trainingPartition,fitPairwise,ordered,rankingMetrics,summarize,type Query,type Candidate,type Method} from './reranker';
type Row=Record<string,any>;
const args=process.argv.slice(2),allowed=new Set(['--root','--output','--model']);
for(let index=0;index<args.length;index+=2)if(!allowed.has(args[index])||!args[index+1])throw new Error('Only --root, --output and --model paths are accepted. Fit policy cannot be overridden.');
const option=(key:string,fallback:string)=>{const index=args.indexOf(key);return index<0?fallback:args[index+1];},root=resolve(option('--root',process.cwd()));
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),read=(path:string)=>readFileSync(resolve(root,path));
const policyBytes=read('evals/reranker_v1/policy.json'),policyHash=hash(policyBytes),policy=JSON.parse(policyBytes.toString());
if(policyHash!=='15411534f0ac179b6e529311f6a9d884385e78033566e590d5627d9617915f45')throw new Error('Frozen experiment policy changed; version a new experiment instead.');
if(JSON.stringify(FEATURE_NAMES)!==JSON.stringify(policy.features))throw new Error('Feature schema differs from the frozen policy.');
// A late accidental provider path must fail, not silently spend a key or budget.
globalThis.fetch=async()=>{throw new Error('Network access is forbidden in the reranker experiment.');};
const corpusBytes=read(policy.data.corpus_path),vectorBytes=read(policy.data.vectors_path);
if(hash(corpusBytes)!==policy.data.corpus_sha256||hash(vectorBytes)!==policy.data.vectors_sha256)throw new Error('Frozen corpus or vector artifact changed.');
const manifest=JSON.parse(read('evals/hireflow_v1/manifest.json').toString()),vectors=JSON.parse(vectorBytes.toString());
if(manifest.sha256!==hash(corpusBytes)||vectors.corpus_sha256!==hash(corpusBytes)||vectors.model!==manifest.model||vectors.pooling!=='cls'||vectors.dimensions!==384)throw new Error('Frozen vector provenance mismatch.');
const corpus:Row[]=corpusBytes.toString().trim().split('\n').map(line=>JSON.parse(line)),cases=corpus.filter(item=>item.kind==='ranking');
if(corpus.length!==manifest.case_count||cases.length!==policy.data.ranking_cases)throw new Error('Unexpected corpus cardinality.');
function frozenVector(key:string,text:string):number[]{
 const value=vectors.vectors[key];
 if(vectors.input_sha256[key]!==hash(text)||!Array.isArray(value)||value.length!==384||value.some(item=>!Number.isFinite(item))||value.every(item=>item===0))throw new Error('Invalid/stale frozen vector input.');
 return value;
}
const featureStarted=performance.now();
const queries:Query[]=cases.map(item=>{
 if(!['dev','heldout'].includes(item.split)||!Array.isArray(item.candidates)||item.candidates.length!==5)throw new Error('Unexpected frozen ranking schema.');
 const profileText=profileEmbeddingText(item.profile),profileVector=frozenVector(item.id+':profile',profileText);
 return {id:item.id,group:item.group,split:item.split,mode:item.profile.mode,profileFingerprint:hash(profileText),candidates:item.candidates.map((job:Row)=>{
  const lexical=scoreMatch(item.profile,job as any),jobText=jobEmbeddingText(job),semantic=cosineSimilarity(profileVector,frozenVector(item.id+':job:'+job.id,jobText));
  if(!Number.isInteger(job.relevance)||job.relevance<0||job.relevance>3||!Number.isSafeInteger(job.id))throw new Error('Invalid frozen ranking candidate.');
  return {id:job.id,relevance:job.relevance,features:features(lexical.score,lexical.technical_score,semantic),jobFingerprint:hash(jobText),sentenceFingerprint:hash(firstSentence(job.description)),lexical:lexical.score,hybrid:hybridScore(lexical.score,lexical.technical_score,semantic)};
 })};
});
const featureMs=performance.now()-featureStarted,{training,heldout,excluded,dropped}=trainingPartition(queries);
if(queries.filter(query=>query.split==='dev').length!==policy.data.dev_queries||heldout.length!==policy.data.heldout_queries)throw new Error('Frozen query split changed.');
const fitStarted=performance.now(),model=fitPairwise(training,policy.fit),fitMs=performance.now()-fitStarted;
const trainingDigest=hash(JSON.stringify(training.map(query=>({id:query.id,profile:query.profileFingerprint,candidates:query.candidates.map(candidate=>({id:candidate.id,job:candidate.jobFingerprint,features:candidate.features,relevance:candidate.relevance}))}))));
const metrics=summarize(heldout,model),devMetrics=summarize(queries.filter(query=>query.split==='dev'),model);
const slice=(field:'mode'|'group')=>Object.fromEntries([...new Set(heldout.map(query=>query[field]))].sort().map(value=>{const selected=heldout.filter(query=>query[field]===value);return [value,{queries:selected.length,metrics:summarize(selected,model)}];}));
const modes=slice('mode'),domains=slice('group');
const perQuery=heldout.map(query=>({id:query.id,group:query.group,mode:query.mode,methods:Object.fromEntries((['lexical','hybrid','learned'] as Method[]).map(method=>{const sorted=ordered(query,method,model),measures=rankingMetrics(sorted);return [method,{recall_at_1:measures.recall_at_1,recall_at_3:measures.recall_at_3,ndcg_at_1:measures.ndcg_at_1,ndcg_at_3:measures.ndcg_at_3,order:sorted.map(candidate=>candidate.id),grades:sorted.map(candidate=>candidate.relevance)}];})),candidates:query.candidates.map(candidate=>({id:candidate.id,relevance:candidate.relevance,features:candidate.features}))}));
const previous=JSON.parse(read('evals/results/offline.json').toString());
if(previous.corpus_sha256!==hash(corpusBytes))throw new Error('Published baseline belongs to another corpus.');
for(const query of perQuery){
 const old=previous.ranking.per_query.find((row:Row)=>row.id===query.id);
 for(const method of ['lexical','hybrid'] as const)if(!old||JSON.stringify(old[method].order)!==JSON.stringify(query.methods[method].order)||Math.abs(old[method].ndcg_at_3-query.methods[method].ndcg_at_3)>1e-12)throw new Error('Actual Worker baseline differs from its recorded evaluation.');
}
function benchmark(method:Method){
 const samples:number[]=[];
 for(let repetition=0;repetition<policy.runtime.timing_warmup+policy.runtime.timing_repeats;repetition++)for(const query of heldout){const before=performance.now();ordered(query,method,model);const elapsed=performance.now()-before;if(repetition>=policy.runtime.timing_warmup)samples.push(elapsed);}
 samples.sort((left,right)=>left-right);const percentile=(q:number)=>samples[Math.max(0,Math.ceil(samples.length*q)-1)];
 return {samples:samples.length,candidates_per_query:5,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99)};
}
const latency=Object.fromEntries((['lexical','hybrid','learned'] as Method[]).map(method=>[method,benchmark(method)]));
const domainDeltas=Object.values(domains).map((row:Row)=>row.metrics.learned.ndcg_at_3-row.metrics.hybrid.ndcg_at_3);
let seed=policy.metrics.bootstrap.seed;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;},draws:number[]=[];
for(let draw=0;draw<policy.metrics.bootstrap.samples;draw++)draws.push(domainDeltas.reduce(sum=>sum+domainDeltas[Math.floor(random()*domainDeltas.length)],0)/domainDeltas.length);
draws.sort((left,right)=>left-right);
const interval={unit:'primary domain (both modes together)',domains:domainDeltas.length,samples:draws.length,seed:policy.metrics.bootstrap.seed,lower:draws[Math.floor(draws.length*.025)],upper:draws[Math.min(draws.length-1,Math.floor(draws.length*.975))],note:'Descriptive percentile bootstrap on ten synthetic domains; not independent real-world uncertainty.'};
const errorCounts=Object.fromEntries((['lexical','hybrid','learned'] as Method[]).map(method=>{
 const counts={below_threshold_above_relevant:0,direct_below_adjacent:0,adjacent_below_generic:0,irrelevant_in_top3:0};
 for(const query of heldout){const grades=ordered(query,method,model).map(candidate=>candidate.relevance);if(grades.some((grade,index)=>grade<2&&grades.slice(index+1).some(other=>other>=2)))counts.below_threshold_above_relevant++;if(grades.indexOf(2)<grades.indexOf(3))counts.direct_below_adjacent++;if(grades.indexOf(1)<grades.indexOf(2))counts.adjacent_below_generic++;if(grades.slice(0,3).includes(0))counts.irrelevant_in_top3++;}
 return [method,counts];
}));
const gates=policy.adoption_gates,epsilon=1e-12;
const numericalGates={
 heldout_ndcg_gain:metrics.learned.ndcg_at_3-metrics.hybrid.ndcg_at_3+epsilon>=gates.minimum_heldout_ndcg_at_3_gain_over_hybrid,
 heldout_recall_at_1:metrics.hybrid.recall_at_1-metrics.learned.recall_at_1<=gates.maximum_heldout_recall_at_1_regression+epsilon,
 heldout_recall_at_3:metrics.hybrid.recall_at_3-metrics.learned.recall_at_3<=gates.maximum_heldout_recall_at_3_regression+epsilon,
 mode_ndcg_regression:Object.values(modes).every((row:Row)=>row.metrics.hybrid.ndcg_at_3-row.metrics.learned.ndcg_at_3<=gates.maximum_mode_ndcg_at_3_regression+epsilon),
 domain_ndcg_regression:domainDeltas.every(delta=>delta>=-gates.maximum_domain_ndcg_at_3_regression-epsilon),
 cached_rerank_latency:latency.learned.p95_ms<gates.maximum_cached_five_candidate_rerank_p95_ms,
 bounded_fit:fitMs<gates.maximum_local_fit_ms,
};
const modelArtifact={version:policy.version,policy_sha256:policyHash,corpus_sha256:hash(corpusBytes),vectors_sha256:hash(vectorBytes),training_sha256:trainingDigest,feature_names:FEATURE_NAMES,fit_config:policy.fit,...model,score_semantics:'Uncalibrated ordering score; neither application eligibility nor hiring probability.',production_enabled:false};
const modelBytes=JSON.stringify(modelArtifact,null,2)+'\n',modelPath=resolve(option('--model',`${root}/evals/reranker_v1/results/model.json`));
mkdirSync(dirname(modelPath),{recursive:true});writeFileSync(modelPath,modelBytes);
const report={version:policy.version,created_at:new Date().toISOString(),policy_sha256:policyHash,model_sha256:hash(modelBytes),provenance:{corpus_sha256:hash(corpusBytes),vectors_sha256:hash(vectorBytes),vector_model:vectors.model,vector_revision:vectors.revision,pooling:vectors.pooling,dimensions:vectors.dimensions,label_source:policy.data.label_provenance,feature_source_hashes:Object.fromEntries(['cloudflare/src/intelligence.ts','cloudflare/src/semantic_matching.ts','evals/reranker_v1/reranker.ts','evals/reranker_v1/evaluate.ts'].map(path=>[path,hash(read(path))])),published_baseline_order_and_ndcg_parity:true},
 split:{original_dev_queries:policy.data.dev_queries,original_dev_candidates:policy.data.dev_queries*5,training_queries:training.length,training_candidates:training.reduce((sum,query)=>sum+query.candidates.length,0),training_grade_counts:Object.fromEntries([0,1,2,3].map(grade=>[grade,training.flatMap(query=>query.candidates).filter(candidate=>candidate.relevance===grade).length])),heldout_queries:heldout.length,heldout_candidates:heldout.reduce((sum,query)=>sum+query.candidates.length,0),training_primary_domains:new Set(training.map(query=>query.group)).size,heldout_primary_domains:new Set(heldout.map(query=>query.group)).size,profile_input_overlap:0,post_embargo_job_input_overlap:0,post_embargo_first_sentence_overlap:0,excluded_candidates:excluded,dropped_queries:dropped,heldout_labels_used_for_fit:false,hyperparameter_search:false,other_task_labels_used:false},
 features:FEATURE_NAMES,model:modelArtifact,metrics:{heldout:metrics,development_descriptive_only:devMetrics},slices:{listing_mode:modes,primary_domain:domains,demographic:'Not measurable. No demographic annotations or representative populations; these job-related slices do not establish demographic fairness.'},
 comparison:{heldout_ndcg_at_3_delta:metrics.learned.ndcg_at_3-metrics.hybrid.ndcg_at_3,domain_cluster_bootstrap_95:interval,wins:domainDeltas.filter(value=>value>epsilon).length,ties:domainDeltas.filter(value=>Math.abs(value)<=epsilon).length,losses:domainDeltas.filter(value=>value< -epsilon).length},error_analysis:{count_unit:'queries with at least one such ordering; labels define direct=3, adjacent=2, generic=1, irrelevant/absent stack=0',by_method:errorCounts,per_query:perQuery},
 timing:{source:'Local Node wall clock; cached scalar features only, excluding vector generation, source fetching, Worker CPU and cold startup',node:process.version,platform:process.platform,architecture:process.arch,cpu:cpus()[0]?.model||'unknown',feature_build_ms:featureMs,fit_ms:fitMs,rerank:latency},
 cost:{new_model_inference_requests:0,new_embedding_requests:0,search_requests:0,hosted_cost_usd:0,cloudflare_requests:0,local_compute_cost_usd:null,upstream_vectors:'Previously generated local CPU BGE outputs; reused with pinned model/revision/input hashes. Fresh inference cost is not remeasured.'},
 decision:{state:'not_adopted',numerical_gates:numericalGates,numerical_gates_passed:Object.values(numericalGates).every(Boolean),independent_real_validation_passed:false,production_changes:0,reason:Object.values(numericalGates).every(Boolean)?'Synthetic numerical gates pass, but predeclared independent real relevance validation is absent. Keep the production hybrid unchanged.':'Predeclared numerical adoption gates fail; independent real relevance validation is also absent. Keep the production hybrid unchanged.'},
 limitations:['Only 48 repository-authored synthetic queries, with 28 development/20 reused-heldout and five candidates each. Effective heldout units are ten primary domains.','The published heldout is excluded from fitting/tuning, but is not a newly blind benchmark. This is not hiring-outcome evidence.','First-sentence/exact-input embargo removes literal job reuse; template structure, general skills and some domain concepts still cross the dataset. No claim of semantic independence.','The embargo removes every generic grade-1 training row. The resulting incomplete grade coverage weakens generalization; heldout candidates and labels remain unchanged.','Pairwise labels and domains are synthetic and narrow; no applicant demographic fairness or Indian employment-market validity is established.','No reranking feature vector includes raw candidate identity or a learned embedding-dimension coefficient. Job-related text embeddings can nevertheless retain indirect demographic proxies in real data.','Local cached latency is not Cloudflare CPU, live inference, source throughput or concurrent production capacity.']};
const output=resolve(option('--output',`${root}/evals/reranker_v1/results/experiment.json`));mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,model:modelPath,training_candidates:report.split.training_candidates,heldout_queries:heldout.length,metrics:metrics,comparison:report.comparison,decision:report.decision,timing:{fit_ms:fitMs,learned:latency.learned}},null,2));
