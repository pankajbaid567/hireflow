"""Explicit, bounded provider extraction on six public synthetic source texts.

Uses the same profile-extraction prompt/parser as the Python API. It does not
read any real resume, create users, search, email or submit applications. Provider
keys remain in normal local configuration and never enter reports/arguments.
"""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import time

ROOT=Path(__file__).resolve().parent

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--run-live',action='store_true');parser.add_argument('--output',default=str(ROOT/'results/extraction-live.json'));args=parser.parse_args()
 if not args.run_live:parser.error('--run-live is required for actual provider requests')
 from src.config.settings import get_settings
 from src.utils.llm_client import get_llm_client
 settings=get_settings();client=get_llm_client(settings)
 raw=(ROOT/'hireflow_v1/cases.jsonl').read_bytes();cases={item['id']:item for item in map(json.loads,raw.decode().splitlines())}
 selected=['extract-00','extract-01','extract-02','extract-14','extract-18','extract-20']
 results=[];started=time.perf_counter()
 for id_ in selected:
  case=cases[id_];before=time.perf_counter();row={'id':id_,'split':case['split'],'source':'public synthetic text','success':False}
  try:
   value=client.extract_profile(case['source_text']);expected=case['expected']
   skills={str(skill).casefold() for skill in value.get('skills',[])}
   projects=json.dumps(value.get('projects',[]),ensure_ascii=False).casefold()
   fields={'name':str(value.get('name','')).casefold()==expected['name'].casefold(),
    'email':str(value.get('email','')).casefold()==expected['email'].casefold(),
    'skills':skills=={skill.casefold() for skill in expected['skills']},
    'experience_years':float(value.get('experience_years',0))==expected['experience_years'],
    'project_name':expected['project_name'].casefold() in projects}
   claims=json.dumps({'experience':value.get('experience',[]),'summary':value.get('summary','')},ensure_ascii=False).casefold()
   forbidden=[claim for claim in case['forbidden_claims'] if claim.casefold() in claims]
   row.update(success=True,fields=fields,field_accuracy=sum(fields.values())/len(fields),unsupported_employment_claims=len(forbidden))
  except Exception as error:
   # No raw provider text, prompts, headers, keys or exception strings.
   row.update(error_type=type(error).__name__,fields={},field_accuracy=0,unsupported_employment_claims=None)
  row['latency_ms']=round((time.perf_counter()-before)*1000);results.append(row)
 report={'dataset_version':'hireflow-synthetic-v1','corpus_sha256':hashlib.sha256(raw).hexdigest(),'created_at':datetime.now(timezone.utc).isoformat(),
  'provider':settings.llm_provider,'model':getattr(settings,f'{settings.llm_provider}_model',None),'logical_requests':len(results),
  'transport_requests':None,'request_note':'Six normal wrapper calls; SDK retries are bounded by the configured client. Raw transport/billing usage is not exposed by that wrapper.',
  'synthetic_only':True,'total_extraction_cases':24,'evaluated_subset':selected,'selection_rule':'Fixed before calls: three dev and three heldout cases including JavaScript, Go, Unicode name and an adversarial instruction.',
  'successes':sum(item['success'] for item in results),'field_accuracy':sum(item['field_accuracy'] for item in results)/len(results),
  'unsupported_employment_claims':sum(item.get('unsupported_employment_claims') or 0 for item in results),
  'elapsed_ms':round((time.perf_counter()-started)*1000),'measured_tokens':None,'measured_cost_usd':None,
  'quality_gate_passed':all(item['success'] and item['field_accuracy']>=.95 and item['unsupported_employment_claims']==0 for item in results),
  'scope':'Actual Python provider text extraction; not Gemini PDF vision/intake or full 24-case provider coverage. No independent human annotation claimed.','results':results}
 output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
 if not report['quality_gate_passed']:raise SystemExit(1)
if __name__=='__main__':main()
