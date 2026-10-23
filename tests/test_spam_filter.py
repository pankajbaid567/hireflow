import pytest
from unittest.mock import patch, MagicMock
from src.agents.spam_filter import SpamFilter

@pytest.fixture
def spam_filter():
    # Use a high threshold for testing so we can be sure it works
    with patch("src.agents.spam_filter.get_llm_client"):
        return SpamFilter(threshold=0.7)

def test_missing_company_name(spam_filter):
    # This shouldn't even call the LLM due to the heuristic
    result = spam_filter.score({
        "jd_text": "We are hiring developers.",
        "company_name": "",
        "skills_required": []
    })
    assert result["spam_confidence"] == 1.0
    assert result["is_spam"] is True
    assert "Missing company name" in result["reason"]

@patch("src.agents.spam_filter.get_llm_client")
def test_vague_rockstar_spam(mock_get_llm_client):
    mock_llm = MagicMock()
    mock_llm.extract.return_value = {
        "spam_confidence": 0.95,
        "reasoning": "Vague rockstar language, no skills"
    }
    mock_get_llm_client.return_value = mock_llm
    
    sf = SpamFilter(threshold=0.7)
    result = sf.score({
        "jd_text": "We need a rockstar ninja developer. Great pay. Must be passionate.",
        "company_name": "FakeCo",
        "skills_required": []
    })
    
    assert result["spam_confidence"] == 0.95
    assert result["is_spam"] is True

@patch("src.agents.spam_filter.get_llm_client")
def test_unrealistic_salary_spam(mock_get_llm_client):
    mock_llm = MagicMock()
    mock_llm.extract.return_value = {
        "spam_confidence": 0.85,
        "reasoning": "Unrealistic salary claims for 0 hours of work"
    }
    mock_get_llm_client.return_value = mock_llm
    
    sf = SpamFilter(threshold=0.7)
    result = sf.score({
        "jd_text": "Make $1M a day working 0 hours! Be your own boss.",
        "company_name": "Scam LLC",
        "skills_required": []
    })
    
    assert result["spam_confidence"] == 0.85
    assert result["is_spam"] is True

@patch("src.agents.spam_filter.get_llm_client")
def test_legitimate_sparse_listing(mock_get_llm_client):
    mock_llm = MagicMock()
    mock_llm.extract.return_value = {
        "spam_confidence": 0.1,
        "reasoning": "Sparse but mentions specific skills (Python)"
    }
    mock_get_llm_client.return_value = mock_llm
    
    sf = SpamFilter(threshold=0.7)
    result = sf.score({
        "jd_text": "Looking for a Python intern to help build our data pipeline.",
        "company_name": "DataFlow Labs",
        "skills_required": ["Python"]
    })
    
    assert result["spam_confidence"] == 0.1
    assert result["is_spam"] is False

@patch("src.agents.spam_filter.get_llm_client")
def test_legitimate_detailed_listing(mock_get_llm_client):
    mock_llm = MagicMock()
    mock_llm.extract.return_value = {
        "spam_confidence": 0.0,
        "reasoning": "Detailed, professional job description"
    }
    mock_get_llm_client.return_value = mock_llm
    
    sf = SpamFilter(threshold=0.7)
    result = sf.score({
        "jd_text": "We are a B2B SaaS startup. You will be responsible for leading our backend architecture using Go and PostgreSQL. 5+ years experience required.",
        "company_name": "SolidTech",
        "skills_required": ["Go", "PostgreSQL"]
    })
    
    assert result["spam_confidence"] == 0.0
    assert result["is_spam"] is False

@patch("src.agents.spam_filter.get_llm_client")
def test_llm_failure_fallback(mock_get_llm_client):
    mock_llm = MagicMock()
    mock_llm.extract.side_effect = Exception("API Error")
    mock_get_llm_client.return_value = mock_llm
    
    sf = SpamFilter(threshold=0.7)
    result = sf.score({
        "jd_text": "Some text",
        "company_name": "RealCompany",
        "skills_required": []
    })
    
    # Failsafe should default to NOT spam
    assert result["spam_confidence"] is None
    assert result["is_spam"] is False
    assert result["classification_available"] is False
    assert "not evidence" in result["reason"]
