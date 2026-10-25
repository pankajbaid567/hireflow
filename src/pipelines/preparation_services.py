"""Configured preparation services for the normal Python API/background path.

External generation is opt-in even when provider keys exist for other features.
No provider object or mutable candidate data is cached between requests.
"""

import logging

from src.agents.prep_guide_agent import PrepGuideAgent
from src.config.settings import Settings, get_settings
from src.pipelines.resume_service import ResumeService
from src.utils.llm_client import LLMClientError, get_llm_client

logger = logging.getLogger(__name__)


def _optional_client(settings: Settings, enabled: bool):
    if not enabled:
        return None, []
    try:
        return get_llm_client(settings), []
    except (LLMClientError, ValueError):
        warning = (
            "Optional Python language-model preparation is unavailable. "
            "Using source facts and JD-based guidance; check the configured provider."
        )
        logger.warning(warning)
        return None, [warning]


def build_resume_service(settings: Settings | None = None) -> ResumeService:
    settings = settings or get_settings()
    client, warnings = _optional_client(settings, settings.python_llm_tailoring_enabled)
    service = ResumeService(storage_path=settings.local_storage_path, llm_client=client)
    service.configuration_warnings = warnings
    return service


def build_prep_guide_agent(*, search_client=None, settings: Settings | None = None) -> PrepGuideAgent:
    settings = settings or get_settings()
    client, warnings = _optional_client(settings, settings.python_llm_prep_enabled)
    agent = PrepGuideAgent(llm_client=client, search_client=search_client)
    agent.configuration_warnings = warnings
    return agent
