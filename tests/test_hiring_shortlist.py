"""Shortlisting uses the existing scorer and preserves deterministic ordering."""

import pytest

from src.agents.hiring_shortlist_agent import HiringShortlistAgent
from src.models import Job, ListingType, Shortlist
from src.pipelines.match_scorer import compute_match_score

JD = "AI Engineer Intern - LangChain, Python, RAG required"


def test_shortlist_top_n_matches_issue_example():
    result = HiringShortlistAgent().shortlist(
        JD,
        [
            {"name": "Student A", "skills": ["Python", "LangChain", "FastAPI"]},
            {"name": "Student B", "skills": ["Java", "Spring", "SQL"]},
            {"name": "Student C", "skills": ["Python", "LangChain", "Docker", "RAG"]},
        ],
        shortlist_size=2,
    )
    assert [candidate["name"] for candidate in result["shortlist"]] == [
        "Student C",
        "Student A",
    ]
    assert result["applicant_count"] == 3
    assert result["shortlisted_count"] == 2
    assert set(result["shortlist"][1]["skill_gaps"]) == {"rag"}


def test_shortlist_broad_qualified_candidate_beats_single_skill():
    result = HiringShortlistAgent().shortlist(
        JD,
        [
            {"name": "Python only", "skills": ["Python"]},
            {
                "name": "Qualified",
                "skills": ["Python", "LangChain", "RAG", "Docker", "FastAPI"],
            },
        ],
    )
    assert [candidate["name"] for candidate in result["shortlist"]] == [
        "Qualified",
        "Python only",
    ]
    assert result["shortlist"][0]["score"] > result["shortlist"][1]["score"]


def test_shortlist_score_is_same_as_candidate_matching():
    applicant = {"name": "Student", "skills": ["Python", "RAG"], "mode": "internship"}
    result = HiringShortlistAgent().shortlist(JD, [applicant])
    job = Job(title="", company="", description=JD, listing_type=ListingType.internship)
    expected = compute_match_score(applicant, job)
    candidate = result["shortlist"][0]
    assert candidate["score"] == expected["total_score"]
    assert candidate["factor_scores"] == expected["factor_scores"]
    assert candidate["skill_matches"] == expected["skill_matches"]


def test_shortlist_accepts_csv_skill_lists():
    result = HiringShortlistAgent().shortlist(
        JD,
        "name,skills\nStudent A,Python;LangChain\nStudent B,Java;SQL\nStudent C,Python;LangChain;RAG\n",
        shortlist_size=2,
    )
    assert [candidate["name"] for candidate in result["shortlist"]] == [
        "Student C",
        "Student A",
    ]
    assert result["applicant_count"] == 3


def test_shortlist_ties_keep_input_order():
    result = HiringShortlistAgent().shortlist(
        JD,
        [
            {"name": "Zara", "skills": ["Python", "RAG"]},
            {"name": "Asha", "skills": ["Python", "RAG"]},
        ],
        shortlist_size=1,
    )
    assert [candidate["name"] for candidate in result["shortlist"]] == ["Zara"]


@pytest.mark.parametrize(
    "applicants",
    [
        [],
        [{"name": "No match", "skills": ["Java", "Spring"]}],
        [{"name": "No skills", "skills": []}],
    ],
)
def test_shortlist_no_matching_candidates_is_empty(applicants):
    result = HiringShortlistAgent().shortlist(JD, applicants, shortlist_size=20)
    assert result["shortlist"] == []
    assert result["shortlisted_count"] == 0
    assert result["applicant_count"] == len(applicants)


@pytest.mark.parametrize(
    "jd, size, applicants",
    [
        ("", 2, []),
        (JD, 0, []),
        (JD, -1, []),
        (JD, 2, [{"name": "Bad skills", "skills": "Python"}]),
        (JD, 2, [{"name": "", "skills": ["Python"]}]),
        (JD, 2, [{"name": "Bad item", "skills": [123]}]),
    ],
)
def test_shortlist_invalid_input_is_rejected(jd, size, applicants):
    with pytest.raises(ValueError):
        HiringShortlistAgent().shortlist(jd, applicants, shortlist_size=size)


def test_shortlist_persisted_with_candidates_and_timestamp(db_session):
    result = HiringShortlistAgent().shortlist(
        JD, [{"name": "Student", "skills": ["Python", "RAG"]}], db=db_session
    )
    row = db_session.get(Shortlist, result["id"])
    assert row.jd_text == JD
    assert row.applicant_count == 1
    assert row.candidates["shortlist"] == result["shortlist"]
    assert row.created_at is not None


@pytest.mark.parametrize(
    "applicants",
    [
        [
            {"name": "Student A", "skills": ["Python"]},
            {"name": "Student C", "skills": ["Python", "LangChain", "RAG"]},
        ],
        "name,skills\nStudent A,Python\nStudent C,Python;LangChain;RAG\n",
    ],
)
def test_shortlist_api_json_and_csv_persisted(api_client, db_session, applicants):
    response = api_client.post(
        "/hiring/shortlist",
        json={"jd_text": JD, "applicants": applicants, "shortlist_size": 1},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["shortlist"][0]["name"] == "Student C"
    assert db_session.get(Shortlist, result["id"]).applicant_count == 2


@pytest.mark.parametrize(
    "payload",
    [
        {"jd_text": JD, "applicants": [], "shortlist_size": 0},
        {"jd_text": JD, "applicants": [{"name": "Bad", "skills": "Python"}]},
        {"jd_text": " ", "applicants": []},
    ],
)
def test_shortlist_api_invalid_input_has_clean_error(api_client, payload):
    assert api_client.post("/hiring/shortlist", json=payload).status_code == 422
