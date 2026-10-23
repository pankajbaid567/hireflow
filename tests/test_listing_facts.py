"""Cross-runtime evidence cases and normal persistence/selection behavior."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.models import Application, ApplicationStatus, Job, ListingType, User, UserMode
from src.pipelines.quota_selector import QuotaSelector
from src.utils.listings import (canonical_url, company_key, compensation_fit, listing_quality, parse_compensation, parse_experience)
from src.scrapers.static_scraper import extract_jobs_with_llm

CASES = json.loads((Path(__file__).parent / 'fixtures/listing_contract.json').read_text())

@pytest.mark.parametrize('case', CASES, ids=lambda value: value['id'])
def test_compensation_contract(case):
    actual = parse_compensation(case['text'])
    assert {key: actual[key] for key in case['expected']} == case['expected']


def test_compensation_period_currency_and_overlap_are_explicit():
    assert compensation_fit(parse_compensation('Salary INR 6-10 LPA'), {'min_salary': 800000}, 'job') == .7
    assert compensation_fit(parse_compensation('Stipend INR 20000/month'), {'min_stipend': 19000}, 'internship') == 1
    assert compensation_fit(parse_compensation('Salary USD 100000/year'), {'min_salary': 800000}, 'job') == .5
    assert compensation_fit(parse_compensation('Salary INR 100000'), {'min_salary': 800000}, 'job') == .5
    assert compensation_fit(parse_compensation('3 years experience and 2000000 users'), {'min_stipend': 15000}, 'internship') == .5
    assert compensation_fit(parse_compensation('Unpaid internship'), {'min_stipend': 15000}, 'internship') == .1


@pytest.mark.parametrize('text,minimum,maximum', [('2-5 years of experience',2,5),('Experience: 3+ years',3,None),('Freshers welcome',0,None),('3 years relevant experience',3,None)])
def test_explicit_experience(text, minimum, maximum):
    actual = parse_experience(text)
    assert (actual['minimum_years'],actual['maximum_years']) == (minimum, maximum)
    assert actual['evidence'] in text


def test_experience_unknown_does_not_infer_years_from_dates():
    assert parse_experience('Founded in 2018. Join our 5-person team.') is None


def test_canonical_url_keeps_job_identifiers_and_discards_tracking():
    assert canonical_url('https://example.com/jobs/1/?utm_source=site&job_id=42#apply') == 'https://example.com/jobs/1?job_id=42'
    assert company_key('A.C.M.E. Pvt.Ltd.') == company_key('ACME')
    assert company_key('Acme Consulting') != company_key('Acme Software')


def test_startup_is_not_penalized_for_unknown_brand_or_short_technical_jd():
    assert not listing_quality('Build Python APIs', 'Tiny Startup', ['Python'])['is_spam']
    assert not listing_quality('Python internship. No registration fee required.', 'Tiny Startup', ['Python'])['is_spam']
    assert listing_quality('You must pay a registration fee before interview.', 'Hiring Team', [])['is_spam']


def test_model_normal_path_persists_evidence_and_does_not_promote_unknowns(db_session):
    job=Job(title='Python Intern',company='Tiny Pvt Ltd',url='https://example.com/jobs/1',description='Stipend INR 20000/month. Freshers welcome. Interview has technical and HR rounds.',listing_type=ListingType.internship)
    db_session.add(job);db_session.commit();db_session.refresh(job)
    assert job.source=='example.com' and job.company_key=='tiny'
    assert job.required_skills==['Python'] and job.compensation['monthly_minimum']==20000
    assert job.required_experience['minimum_years']==0 and job.expires_at is None
    assert job.selection_process and job.provenance['schema_version']=='listing-v1'


def _app(db,user,company,status='pending',**extra):
    index=db.query(Job).count()+1
    job=Job(title='Python Intern',company=company,url=f'https://example.com/jobs/{index}',description='Build Python APIs with tests for the engineering team.',listing_type=ListingType.internship,**extra)
    app=Application(user=user,job=job,status=ApplicationStatus(status),match_score=.8)
    db.add(app);db.commit();return app


def test_prior_company_alias_excludes_only_same_employer_and_preserves_history(db_session):
    user=User(name='Owner',email='policy@example.com',mode=UserMode.internship,weekly_quota=3,master_profile={'company_aliases':{'Acme':['Acme Technologies']}})
    db_session.add(user);db_session.commit()
    old=_app(db_session,user,'Acme Pvt. Ltd.','applied')
    alias=_app(db_session,user,'Acme Technologies')
    distinct=_app(db_session,user,'Acme Consulting')
    plan=QuotaSelector(db_session).generate_weekly_plan(user.id)
    assert [item['application_id'] for item in plan['plan']]==[distinct.id]
    assert old.status==ApplicationStatus.applied and alias.status==ApplicationStatus.pending


@pytest.mark.parametrize('status',['failed','needs_action'])
def test_plain_failure_or_captcha_does_not_fabricate_submitted_company(db_session,status):
    user=User(name='Owner',email='failure@example.com',mode=UserMode.internship,weekly_quota=3,master_profile={})
    db_session.add(user);db_session.commit()
    _app(db_session,user,'Same Company',status)
    candidate=_app(db_session,user,'Same Company Limited')
    assert QuotaSelector(db_session).generate_weekly_plan(user.id)['plan'][0]['application_id']==candidate.id


def test_explicit_expiry_prevents_planning(db_session):
    user=User(name='Owner',email='expiry@example.com',mode=UserMode.internship,weekly_quota=3,master_profile={})
    db_session.add(user);db_session.commit()
    _app(db_session,user,'Expired Company',expires_at=datetime.now(timezone.utc)-timedelta(days=1))
    assert QuotaSelector(db_session).generate_weekly_plan(user.id)['plan']==[]


def test_generic_jsonld_extracts_source_jd_fields_without_model(monkeypatch):
    description='Build Python services with SQL and Docker. Salary INR 6-8 LPA. Requires 2 years experience. Technical interview then HR.'
    posting={'@type':'JobPosting','title':'Python Engineer','hiringOrganization':{'name':'Tiny Startup'},'description':description,'url':'https://example.com/jobs/3','datePosted':'2026-10-22','validThrough':'2026-11-30','baseSalary':{'currency':'INR','value':{'minValue':600000,'maxValue':800000,'unitText':'YEAR'}}}
    html='<html><body><script type="application/ld+json">'+json.dumps({'@graph':[posting]})+'</script></body></html>'
    monkeypatch.setattr('src.scrapers.static_scraper.get_llm_client',lambda:pytest.fail('JSON-LD does not need an LLM'))
    jobs=extract_jobs_with_llm(html,'https://example.com/careers')
    assert len(jobs)==1 and jobs[0].description==description
    assert jobs[0].compensation['annual_minimum']==600000 and jobs[0].expires_at
    assert jobs[0].provenance['kind']=='json_ld'


def test_static_detail_loader_verifies_real_description_instead_of_model_invention(monkeypatch):
    class Model:
        def extract(self,_):return [{'title':'Python Engineer','url':'/jobs/1','description':'Invented text must never be used'}]
    monkeypatch.setattr('src.scrapers.static_scraper.get_llm_client',lambda:Model())
    description='Python Engineer. Build reliable Python APIs and SQL data services. Work with our engineering team, tests and documented deployment workflows.'
    jobs=extract_jobs_with_llm('<a href="/jobs/1">Python Engineer</a>','https://example.com/careers',detail_loader=lambda url:'<main>'+description+'</main>')
    assert jobs[0].description==description
    assert 'Invented' not in jobs[0].description


def test_orm_jd_edit_refreshes_derived_facts_and_selector_history_cache(db_session):
    user=User(name='Owner',email='updates@example.com',mode=UserMode.internship,weekly_quota=3,master_profile={})
    db_session.add(user);db_session.commit()
    first=_app(db_session,user,'Original Employer')
    other=_app(db_session,user,'Original Employer Limited')
    selector=QuotaSelector(db_session)
    assert len(selector.generate_weekly_plan(user.id)['plan'])==2
    first.status=ApplicationStatus.applied
    first.job.description='Stipend INR 30000/month. Requires 2 years experience. Build Rust APIs.'
    db_session.commit()
    assert first.job.compensation['monthly_minimum']==30000
    assert first.job.required_experience['minimum_years']==2
    assert selector.generate_weekly_plan(user.id)['plan']==[]


def test_empty_and_placeholder_jds_do_not_enter_scraper_persistence(monkeypatch,db_session):
    from src.scrapers.db_utils import save_jobs_to_db
    from unittest.mock import MagicMock
    factory=MagicMock(return_value=db_session)
    monkeypatch.setattr('src.scrapers.db_utils.SessionLocal',factory)
    jobs=[Job(title='Python Engineer',company='Small Startup',url=f'https://example.com/incomplete/{index}',description=text,listing_type=ListingType.job) for index,text in enumerate(['','Extracted via Generic Scraper','Python snippet'])]
    assert save_jobs_to_db(jobs)==0
    assert db_session.query(Job).count()==0
