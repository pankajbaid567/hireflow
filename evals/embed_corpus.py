"""Opt-in local real-model inference for the frozen public synthetic corpus.

Uses the BAAI weights and CLS pooling also selected by the Worker binding. This
is CPU inference, not a claim that a Cloudflare request ran. No provider key is
read; downloading the public model is the only possible outbound activity.
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--output',default=str(ROOT/'hireflow_v1/bge_cls_vectors.json'));args=parser.parse_args()
 os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS','1');os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY','1')
 import certifi
 os.environ.setdefault('SSL_CERT_FILE',certifi.where());os.environ.setdefault('REQUESTS_CA_BUNDLE',certifi.where())
 import torch
 torch.set_num_threads(2)
 from sentence_transformers import SentenceTransformer
 from src.pipelines.embedding_pipeline import profile_embedding_text,job_embedding_text
 corpus=ROOT/'hireflow_v1/cases.jsonl';cases=[json.loads(line) for line in corpus.read_text().splitlines()]
 inputs={}
 for case in cases:
  if case['kind']!='ranking':continue
  inputs[case['id']+':profile']=profile_embedding_text(case['profile'])
  for job in case['candidates']:inputs[case['id']+':job:'+str(job['id'])]=job_embedding_text(job)
 texts=list(dict.fromkeys(inputs.values()));started=time.perf_counter()
 model=SentenceTransformer('BAAI/bge-small-en-v1.5',device='cpu')
 pooling=model[1].get_config_dict();assert pooling.get('pooling_mode')=='cls' or pooling.get('pooling_mode_cls_token'),pooling
 loaded=time.perf_counter();vectors=model.encode(texts,batch_size=24,convert_to_numpy=True,normalize_embeddings=True,show_progress_bar=False)
 elapsed=time.perf_counter();by_text={text:[round(float(value),7) for value in vector] for text,vector in zip(texts,vectors)}
 payload={'model':'BAAI/bge-small-en-v1.5','cloudflare_model':'@cf/baai/bge-small-en-v1.5','revision':getattr(model[0].auto_model.config,'_commit_hash',None),'pooling':'cls','dimensions':384,'inference':'local CPU sentence-transformers; not a Cloudflare request','corpus_sha256':hashlib.sha256(corpus.read_bytes()).hexdigest(),'unique_texts':len(texts),'input_characters':sum(map(len,texts)),'model_load_ms':round((loaded-started)*1000),'encode_total_ms':round((elapsed-loaded)*1000),'hosted_inference_requests':0,'measured_hosted_cost_usd':0,'local_compute_cost_usd':None,'input_sha256':{key:hashlib.sha256(value.encode()).hexdigest() for key,value in inputs.items()},'vectors':{key:by_text[value] for key,value in inputs.items()}}
 output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(payload,separators=(',',':'))+'\n')
 print(json.dumps({key:value for key,value in payload.items() if key not in ['vectors','input_sha256']},indent=2))
if __name__=='__main__':main()
