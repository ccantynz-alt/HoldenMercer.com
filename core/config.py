from functools import lru_cache

from pydantic import ConfigDict
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = ConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    bedrock_model_id: str = "anthropic.claude-sonnet-4-5"
    supabase_url: str = ""
    supabase_key: str = ""
    database_url: str = ""
    openai_api_key: str = ""
    redis_url: str = "redis://localhost:6379/0"
    log_level: str = "INFO"
    environment: str = "development"

    # Security
    sovereign_api_key: str = ""        # legacy shared-token (still accepted for curl/tools)
    sovereign_secret_key: str = ""     # preferred name (takes precedence)
    allowed_origins: str = "http://localhost:5173,http://localhost:8000"
    development_mode: bool = False

    # Single-user login (email + password gate for the dashboard)
    admin_email:        str = ""
    admin_password:     str = ""        # plaintext compared via secrets.compare_digest
    session_secret:     str = ""        # HMAC key for signing session tokens
    session_ttl_hours:  int = 168       # 7 days

    # GlueCron — GitHub-based native memory
    gluecron_github_token: str = ""   # PAT with repo:read scope
    gluecron_github_org: str = ""     # org or username that owns GlueCron repos

    # Centralized agent dispatch — the repo that hosts THE Holden Mercer task
    # workflow. Every background-task dispatch (regardless of which project
    # repo it operates on) goes to this repo's workflow, which then targets
    # the project repo via the `target_repo` workflow input. Means one
    # ANTHROPIC_API_KEY secret + one HM_PAT secret in this central repo,
    # zero per-project secret setup.
    hm_dispatch_repo: str = "ccantynz-alt/HoldenMercer.com"

    # Provider for code-host operations. The CodeHost interface in
    # core/providers/base.py keeps callers neutral. Supported today:
    #   "github"    → core/providers/github.py
    #   "gluecron"  → core/providers/gluecron.py
    code_host: str = "github"

    # GlueCron — our GitHub equivalent. URLs default to the public hosted
    # instance; override for self-hosted GlueCron deployments.
    gluecron_api_url:  str = "https://gluecron.com/api/v2"
    gluecron_raw_base: str = "https://gluecron.com"

    # CronTech — deployment target + voice provider
    crontech_api_url: str = ""        # e.g. https://api.crontech.ai
    crontech_api_key: str = ""        # CronTech service account key
    crontech_voice_url: str = ""      # WSS endpoint for CronTech voice (nova-compatible)
    crontech_enabled: bool = False    # explicit opt-in flag

    # Infrastructure mode — "DEEPGRAM" | "CRONTECH"
    # Auto-promotes to CRONTECH when crontech_api_key is set and this is unset
    infra_mode: str = "DEEPGRAM"

    # Deepgram (used when infra_mode=DEEPGRAM)
    deepgram_api_key: str = ""

    # GlueCron write access — PAT needs repo:write scope (same token used for read)
    gluecron_staging: bool = True     # commit to staging branch, not main

    # Resiliency tuning
    max_retries: int = 10
    base_retry_delay: float = 1.0
    max_retry_delay: float = 60.0
    request_timeout: float = 120.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
