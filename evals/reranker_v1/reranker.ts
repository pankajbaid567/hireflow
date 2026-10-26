/** Offline experiment only. No production matching imports or activation. */
export const FEATURE_NAMES = ['lexical_score','technical_score','semantic_cosine','technical_x_semantic'] as const;
export interface Candidate {
 id:number; relevance:number; features:number[]; jobFingerprint:string; sentenceFingerprint:string;
 lexical:number; hybrid:number;
}
export interface Query {
 id:string; group:string; split:'dev'|'heldout'; mode:string; profileFingerprint:string; candidates:Candidate[];
}
export interface FitConfig {iterations:number;learning_rate:number;l2:number;initial_weights:number[];}
export interface Model {weights:number[];iterations:number;pairs:number;training_queries:number;initial_loss:number;final_loss:number;}
export const features=(lexical:number,technical:number,semantic:number)=>{
 const values=[lexical,technical,semantic,technical*semantic];
 if(values.some(value=>!Number.isFinite(value)||value<0||value>1))throw new Error('Feature values must be finite and bounded.');
 return values;
};
export function firstSentence(source:string):string {
 return source.trim().split(/(?<=[.!?])\s+|[\r\n]+/)[0].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
export function trainingPartition(queries:Query[]){
 if(new Set(queries.map(query=>query.id)).size!==queries.length)throw new Error('Repeated query identity.');
 const dev=queries.filter(query=>query.split==='dev'),heldout=queries.filter(query=>query.split==='heldout');
 if(!dev.length||!heldout.length)throw new Error('Both frozen splits are required.');
 const domains=new Set(heldout.map(query=>query.group)),profiles=new Set(heldout.map(query=>query.profileFingerprint));
 if(dev.some(query=>domains.has(query.group)))throw new Error('Primary domain crosses the heldout boundary.');
 if(dev.some(query=>profiles.has(query.profileFingerprint)))throw new Error('Profile input crosses the heldout boundary.');
 const jobs=new Set(heldout.flatMap(query=>query.candidates.map(candidate=>candidate.jobFingerprint))),sentences=new Set(heldout.flatMap(query=>query.candidates.map(candidate=>candidate.sentenceFingerprint)));
 const excluded:{query_id:string;candidate_id:number;reason:string}[]=[],dropped:string[]=[];
 const training=dev.flatMap(query=>{
  const candidates=query.candidates.filter(candidate=>{
   const reason=jobs.has(candidate.jobFingerprint)?'shared_job_input':sentences.has(candidate.sentenceFingerprint)?'shared_first_description_sentence':null;
   if(reason)excluded.push({query_id:query.id,candidate_id:candidate.id,reason});return !reason;
  });
  if(new Set(candidates.map(candidate=>candidate.relevance)).size<2){dropped.push(query.id);return [];}
  return [{...query,candidates}];
 });
 if(!training.length)throw new Error('Leakage embargo left no trainable queries.');
 return {training,heldout,excluded,dropped};
}
const dot=(left:number[],right:number[])=>left.reduce((sum,value,index)=>sum+value*right[index],0);
export function predict(model:Pick<Model,'weights'>,values:number[]):number {
 if(values.length!==FEATURE_NAMES.length||model.weights.length!==FEATURE_NAMES.length||[...values,...model.weights].some(value=>!Number.isFinite(value))||values.some(value=>value<0||value>1))throw new Error('Invalid reranker dimensions or values.');
 return dot(model.weights,values);
}
export function fitPairwise(queries:Query[],config:FitConfig):Model {
 if(!queries.length||queries.some(query=>query.split!=='dev'))throw new Error('Only development queries may enter fitting.');
 if(!Number.isInteger(config.iterations)||config.iterations<1||config.iterations>10000||config.learning_rate<=0||!Number.isFinite(config.learning_rate)||config.l2<0||!Number.isFinite(config.l2)||config.initial_weights.length!==FEATURE_NAMES.length||config.initial_weights.some(value=>!Number.isFinite(value)))throw new Error('Invalid bounded fit configuration.');
 const pairs:{difference:number[];weight:number}[]=[];
 for(const query of queries){
  if(new Set(query.candidates.map(candidate=>candidate.id)).size!==query.candidates.length)throw new Error('Repeated within-query candidate identity.');
  const local:number[][]=[];
  for(const high of query.candidates){
   predict({weights:config.initial_weights},high.features);
   if(!Number.isInteger(high.relevance)||high.relevance<0||high.relevance>3)throw new Error('Invalid synthetic relevance grade.');
   for(const low of query.candidates)if(high.relevance>low.relevance)local.push(high.features.map((value,index)=>value-low.features[index]));
  }
  if(!local.length)throw new Error('Each training query needs distinct relevance grades.');
  for(const difference of local)pairs.push({difference,weight:1/(queries.length*local.length)});
 }
 const weights=[...config.initial_weights];
 const loss=()=>pairs.reduce((sum,pair)=>{const z=-dot(weights,pair.difference);return sum+pair.weight*(Math.max(0,z)+Math.log1p(Math.exp(-Math.abs(z))));},config.l2*dot(weights,weights)/2);
 const initial_loss=loss();
 for(let step=0;step<config.iterations;step++){
  const gradient=weights.map(value=>config.l2*value);
  for(const pair of pairs){const margin=dot(weights,pair.difference),error=margin>=0?Math.exp(-margin)/(1+Math.exp(-margin)):1/(1+Math.exp(margin));for(let index=0;index<weights.length;index++)gradient[index]-=pair.weight*error*pair.difference[index];}
  for(let index=0;index<weights.length;index++)weights[index]-=config.learning_rate*gradient[index];
 }
 if(weights.some(value=>!Number.isFinite(value)))throw new Error('Fit diverged.');
 return {weights,iterations:config.iterations,pairs:pairs.length,training_queries:queries.length,initial_loss,final_loss:loss()};
}
export type Method='lexical'|'hybrid'|'learned';
export function ordered(query:Query,method:Method,model:Pick<Model,'weights'>):Candidate[]{
 const score=(candidate:Candidate)=>method==='learned'?predict(model,candidate.features):candidate[method];
 return [...query.candidates].sort((left,right)=>score(right)-score(left)||left.id-right.id);
}
export function rankingMetrics(candidates:Candidate[]){
 const relevant=candidates.filter(candidate=>candidate.relevance>=2).length,ideal=[...candidates].sort((left,right)=>right.relevance-left.relevance);
 const dcg=(items:Candidate[])=>items.reduce((sum,candidate,index)=>sum+(2**candidate.relevance-1)/Math.log2(index+2),0);
 return Object.fromEntries([1,3].flatMap(k=>{
  const selected=candidates.slice(0,k),best=dcg(ideal.slice(0,k));
  return [[`recall_at_${k}`,relevant?selected.filter(candidate=>candidate.relevance>=2).length/relevant:0],[`ndcg_at_${k}`,best?dcg(selected)/best:0]];
 })) as Record<string,number>;
}
export function summarize(queries:Query[],model:Pick<Model,'weights'>){
 if(!queries.length)throw new Error('Cannot summarize an empty split.');
 return Object.fromEntries((['lexical','hybrid','learned'] as const).map(method=>{
  const rows=queries.map(query=>rankingMetrics(ordered(query,method,model)));
  return [method,Object.fromEntries(Object.keys(rows[0]).map(metric=>[metric,rows.reduce((sum,row)=>sum+row[metric],0)/rows.length]))];
 })) as Record<Method,Record<string,number>>;
}
