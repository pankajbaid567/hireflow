import pytest

from src.config.settings import Settings, get_settings
from src.utils.llm_client import (
    AnthropicLLMClient,
    GeminiLLMClient,
    GroqLLMClient,
    LLMClientError,
    OllamaLLMClient,
    OpenAILLMClient,
    get_llm_client,
)


def test_get_llm_client_selects_groq():
    settings = Settings(llm_provider="groq", groq_api_key="test-key")
    client = get_llm_client(settings)
    assert isinstance(client, GroqLLMClient)


def test_get_llm_client_selects_gemini():
    settings = Settings(llm_provider="gemini", google_api_key="test-key")
    client = get_llm_client(settings)
    assert isinstance(client, GeminiLLMClient)


def test_get_llm_client_selects_openai():
    settings = Settings(llm_provider="openai", openai_api_key="test-key")
    client = get_llm_client(settings)
    assert isinstance(client, OpenAILLMClient)


def test_get_llm_client_selects_anthropic():
    settings = Settings(llm_provider="anthropic", anthropic_api_key="test-key")
    client = get_llm_client(settings)
    assert isinstance(client, AnthropicLLMClient)


def test_get_llm_client_selects_ollama_without_key():
    settings = Settings(llm_provider="ollama")
    client = get_llm_client(settings)
    assert isinstance(client, OllamaLLMClient)


def test_get_llm_client_requires_groq_key():
    settings = Settings(llm_provider="groq", groq_api_key=None)
    with pytest.raises(LLMClientError, match="GROQ_API_KEY"):
        get_llm_client(settings)

    settings_placeholder = Settings(
        llm_provider="groq", groq_api_key="your_groq_api_key_here"
    )
    with pytest.raises(LLMClientError, match="GROQ_API_KEY"):
        get_llm_client(settings_placeholder)


def test_get_llm_client_requires_gemini_key():
    settings = Settings(
        _env_file=None, llm_provider="gemini", gemini_api_key=None, google_api_key=None
    )
    with pytest.raises(LLMClientError, match="GOOGLE_API_KEY"):
        get_llm_client(settings)

    settings_placeholder = Settings(
        _env_file=None,
        llm_provider="gemini",
        gemini_api_key="your_gemini_api_key_here",
        google_api_key="your_google_api_key_here",
    )
    with pytest.raises(LLMClientError, match="GOOGLE_API_KEY"):
        get_llm_client(settings_placeholder)


def test_get_llm_client_requires_openai_key():
    settings = Settings(llm_provider="openai", openai_api_key=None)
    with pytest.raises(LLMClientError, match="OPENAI_API_KEY"):
        get_llm_client(settings)

    settings_placeholder = Settings(
        llm_provider="openai", openai_api_key="your_openai_api_key_here"
    )
    with pytest.raises(LLMClientError, match="OPENAI_API_KEY"):
        get_llm_client(settings_placeholder)


def test_get_llm_client_requires_anthropic_key():
    settings = Settings(llm_provider="anthropic", anthropic_api_key=None)
    with pytest.raises(LLMClientError, match="ANTHROPIC_API_KEY"):
        get_llm_client(settings)

    settings_placeholder = Settings(
        llm_provider="anthropic", anthropic_api_key="your_anthropic_api_key_here"
    )
    with pytest.raises(LLMClientError, match="ANTHROPIC_API_KEY"):
        get_llm_client(settings_placeholder)


def test_get_llm_client_invalid_provider():
    settings = Settings(llm_provider="invalid")
    with pytest.raises(LLMClientError, match="Unsupported LLM provider"):
        get_llm_client(settings)


def test_live_llm_client():
    import os

    if os.environ.get("RUN_LIVE_LLM_TESTS") != "1":
        pytest.skip("Set RUN_LIVE_LLM_TESTS=1 to exercise a paid/live provider")
    settings = get_settings()
    provider = settings.llm_provider.lower().strip()

    # Check if we have active credentials
    has_credentials = False
    if (
        provider == "groq"
        and settings.groq_api_key
        and "your_" not in settings.groq_api_key
    ):
        has_credentials = True
    elif (
        provider == "gemini"
        and (settings.gemini_api_key or settings.google_api_key)
        and "your_" not in (settings.gemini_api_key or settings.google_api_key)
    ):
        has_credentials = True
    elif (
        provider == "openai"
        and settings.openai_api_key
        and "your_" not in settings.openai_api_key
    ):
        has_credentials = True
    elif (
        provider == "anthropic"
        and settings.anthropic_api_key
        and "your_" not in settings.anthropic_api_key
    ):
        has_credentials = True
    elif provider == "ollama":
        # Check if Ollama is running
        import httpx

        try:
            httpx.get(settings.ollama_base_url, timeout=1.0)
            has_credentials = True
        except Exception:
            has_credentials = False

    if not has_credentials:
        pytest.skip(
            f"Live provider '{provider}' API key/endpoint not configured. Skipping live test."
        )

    client = get_llm_client(settings)

    # Test chat response
    chat_response = client.chat("Respond with only the word 'Hello'.")
    assert chat_response is not None
    assert "hello" in chat_response.lower()

    # Test extract response
    prompt = "Extract skills as a JSON list from this text: 'Senior developer with Python, FastAPI, and Kubernetes experience.'"
    result = client.extract(prompt)
    assert isinstance(result, (list, dict))

    if isinstance(result, list):
        skills = [s.lower() for s in result]
    else:
        # Check dictionary keys / values
        skills_val = result.get("skills", result)
        if isinstance(skills_val, list):
            skills = [s.lower() for s in skills_val]
        else:
            skills = [str(skills_val).lower()]

    assert any("python" in s for s in skills)


def test_default_model_ids_are_current():
    settings = Settings(_env_file=None)
    assert settings.groq_model == "openai/gpt-oss-20b"
    assert settings.gemini_model == "gemini-3.8-flash"


@pytest.mark.parametrize(
    "primary,legacy,expected",
    [
        ("new-key", "legacy-key", "new-key"),
        (None, "legacy-key", "legacy-key"),
        ("your_gemini_api_key_here", "legacy-key", "legacy-key"),
    ],
)
def test_gemini_supports_both_key_names_and_prefers_explicit_gemini_key(
    primary, legacy, expected
):
    settings = Settings(
        _env_file=None,
        llm_provider="gemini",
        gemini_api_key=primary,
        google_api_key=legacy,
    )
    client = get_llm_client(settings)
    assert isinstance(client, GeminiLLMClient)
    assert client.api_key == expected


def test_gemini_uses_modern_sdk_stateless_interactions_and_answer_text(monkeypatch):
    from unittest.mock import MagicMock
    from types import SimpleNamespace
    from google import genai

    factory = MagicMock()
    sdk = factory.return_value.__enter__.return_value
    sdk.interactions.create.return_value = SimpleNamespace(
        output_text='["Python", "FastAPI"]'
    )
    monkeypatch.setattr(genai, "Client", factory)
    client = GeminiLLMClient("test-gemini", "models/gemini-3.8-flash")
    assert client.extract("Extract skills as JSON") == ["Python", "FastAPI"]
    factory.assert_called_once_with(
        api_key="test-gemini",
        http_options={"timeout": 60000, "retry_options": {"attempts": 1}},
    )
    call = sdk.interactions.create.call_args.kwargs
    assert call["model"] == "gemini-3.8-flash"
    assert call["store"] is False
    assert call["timeout"] == 60
    assert call["generation_config"]["max_output_tokens"] == 4096
    factory.return_value.__exit__.assert_called_once()


def test_groq_uses_configured_model_and_bounded_output(monkeypatch):
    from unittest.mock import MagicMock
    from types import SimpleNamespace
    import groq

    factory = MagicMock()
    sdk = factory.return_value.__enter__.return_value
    sdk.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="Hello"))]
    )
    monkeypatch.setattr(groq, "Groq", factory)
    assert GroqLLMClient("test-groq", "openai/gpt-oss-20b").chat("Hello") == "Hello"
    assert sdk.chat.completions.create.call_args.kwargs["model"] == "openai/gpt-oss-20b"
    assert sdk.chat.completions.create.call_args.kwargs["max_completion_tokens"] == 4096
    factory.return_value.__exit__.assert_called_once()


@pytest.mark.parametrize("provider", ["groq", "gemini"])
def test_provider_errors_redact_credentials_and_hide_unsanitized_cause(
    monkeypatch, provider
):
    from unittest.mock import MagicMock
    import groq
    from google import genai

    factory = MagicMock()
    sdk = factory.return_value.__enter__.return_value
    failure = RuntimeError("provider rejected sensitive-test-secret")
    if provider == "groq":
        monkeypatch.setattr(groq, "Groq", factory)
        sdk.chat.completions.create.side_effect = failure
        client = GroqLLMClient("sensitive-test-secret", "openai/gpt-oss-20b")
    else:
        monkeypatch.setattr(genai, "Client", factory)
        sdk.interactions.create.side_effect = failure
        client = GeminiLLMClient("sensitive-test-secret", "gemini-3.8-flash")
    with pytest.raises(LLMClientError) as exc:
        client.chat("Hello")
    assert "sensitive-test-secret" not in str(exc.value)
    assert "[REDACTED]" in str(exc.value)
    assert exc.value.__suppress_context__
