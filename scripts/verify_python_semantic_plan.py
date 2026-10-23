"""Opt-in real cached-model → FAISS → normal authenticated weekly-plan route.

Only a new temporary SQLite workspace is used. No provider key, model download,
employer request, queue confirmation or email is permitted in this check.
"""
import argparse
from pathlib import Path
import json
import os
import tempfile
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
 parser=argparse.ArgumentParser();parser.add_argument('--run-local',action='store_true');parser.add_argument('--output');args=parser.parse_args()
 if not args.run_local:parser.error('--run-local is required to load the cached public model')
 directory=Path(tempfile.mkdtemp(prefix='hireflow-python-semantic-plan-'));directory.chmod(0o700)
 os.environ.update(DATABASE_URL='sqlite:///'+str(directory/'qa.sqlite'),LOCAL_STORAGE_PATH=str(directory/'data'),FAISS_INDEX_PATH=str(directory/'vectors'),SEMANTIC_MATCHING_ENABLED='true',EMBEDDING_MODEL='BAAI/bge-small-en-v1.5',HF_HUB_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
 for key in ['GROQ_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','TAVILY_API_KEY','SERPAPI_API_KEY','SENDGRID_API_KEY','RESEND_API_KEY']:os.environ[key]=''
 import torch
 torch.set_num_threads(2)
 from fastapi.testclient import TestClient
 from src.api.main import app
 from src.config.database import engine,SessionLocal,Base
 from src.models import Job,ListingType,Application
 import src.pipelines.embedding_pipeline as embeddings
 from src.pipelines.match_scorer import compute_match_score
 from unittest.mock import patch
 Base.metadata.create_all(engine)
 profile={'name':'Synthetic Library Candidate','email':'semantic-plan@example.com','skills':['Python','SQL'],'target_roles':['Software Engineer'],'preferred_locations':['Remote'],'experience_years':0,'mode':'internship','weekly_quota':1,'summary':'Built a Python and SQL library catalog search application for university students.','projects':[{'name':'Campus Book Finder','description':'Indexed library books and implemented relevant catalog search for university students.','tech':['Python','SQL']}],'education':[{'degree':'B.Tech','institution':'Synthetic Institute','year':'2026'}]}
 proof={'status':'running','scope':'fresh synthetic SQLite/API only; real cached BGE weights and real FAISS','directory':str(directory),'provider_requests':0,'employer_requests':0,'queue_confirmations':0,'emails':0,'model':'BAAI/bge-small-en-v1.5','pooling':'cls','profile_contact_used_for_embedding':False}
 started=time.perf_counter()
 with TestClient(app) as client:
  created=client.post('/profile',json=profile);assert created.status_code==201,created.status_code;owner=created.json()['id']
  with SessionLocal() as db:
   rows=[Job(title='Backend Developer Intern',company='Synthetic Marine Lab',location='Remote',description='Use Python and SQL to analyze marine biology samples and monitor coral reef observations.',url='https://example.com/jobs/semantic-marine',listing_type=ListingType.internship),Job(title='Backend Developer Intern',company='Synthetic Library Tools',location='Remote',description='Use Python and SQL to index library books and help students search university collections.',url='https://example.com/jobs/semantic-library',listing_type=ListingType.internship)]
   db.add_all(rows);db.commit();ids=[row.id for row in rows];scores=[compute_match_score(profile,row)['total_score'] for row in rows];assert scores[0]==scores[1]
  original=embeddings._get_faiss
  with patch.object(embeddings,'_get_faiss',wraps=original) as actual_faiss:
   response=client.get(f'/weekly-plan/{owner}');assert response.status_code==200,response.status_code;plan=response.json();assert actual_faiss.call_count>=1
  assert plan['plan'][0]['job_id']==ids[1],plan['plan']
  with SessionLocal() as db:
   stored=db.query(Application).filter_by(user_id=owner).order_by(Application.job_id).all();assert len(stored)==2
   assert all(item.skill_gaps.get('matching_method')=='hybrid' for item in stored)
   assert all(item.status.value in ['pending','planned'] for item in stored)
   proof.update(owner_id=owner,lexical_order=ids,lexical_scores=scores,actual_plan_job_id=plan['plan'][0]['job_id'],actual_matching_method=plan['plan'][0]['matching_method'],faiss_calls=actual_faiss.call_count,semantic_scores={str(item.job_id):item.skill_gaps['semantic_score'] for item in stored},match_scores={str(item.job_id):item.match_score for item in stored},pdf_prepared=bool(stored[1].resume_path and Path(stored[1].resume_path).is_file()),status='passed')
  model=embeddings._model;proof['model_revision']=getattr(model[0].auto_model.config,'_commit_hash',None);proof['actual_pooling']=model[1].get_config_dict();proof['device']=str(model.device)
  assert proof['model_revision']=='5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';assert proof['actual_matching_method']=='hybrid' and proof['pdf_prepared']
  assert client.post('/session/logout',json={}).status_code==200
  assert client.get(f'/profile/{owner}').status_code==401
 proof['elapsed_ms']=round((time.perf_counter()-started)*1000);proof['vector_cache_files']=len(list((directory/'vectors').rglob('*.json')))
 output=Path(args.output) if args.output else directory/'proof.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(proof,indent=2)+'\n');output.chmod(0o600)
 print(json.dumps(proof,indent=2));print('PROOF',output)
if __name__=='__main__':main()
