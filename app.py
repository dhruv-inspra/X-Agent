import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
PROMPT_PATH = BASE_DIR / "Prompt.md"
STATIC_DIR = BASE_DIR / "static"
XAI_SESSION_URL = "https://api.x.ai/v1/realtime/client_secrets"

load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="xAI Voice Agent Console")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def load_prompt() -> str:
    if not PROMPT_PATH.exists():
        raise HTTPException(status_code=500, detail="Prompt.md was not found.")
    return PROMPT_PATH.read_text(encoding="utf-8").strip()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/config")
async def config() -> dict:
    return {
        "model": os.getenv("XAI_VOICE_MODEL", "grok-voice-think-fast-1.0"),
        "voice": os.getenv("XAI_VOICE", "rex"),
        "playbackSpeed": float(os.getenv("XAI_PLAYBACK_SPEED", "1.12")),
        "sampleRate": 24000,
    }


@app.post("/session")
async def session() -> dict:
    api_key = os.getenv("XAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="Set XAI_API_KEY in your local .env file or hosting environment variables before starting a voice session.",
        )

    try:
        token_ttl = int(os.getenv("XAI_TOKEN_TTL_SECONDS", "300"))
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="XAI_TOKEN_TTL_SECONDS must be an integer.") from exc

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            XAI_SESSION_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"expires_after": {"seconds": token_ttl}},
        )

    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"xAI token request failed: {response.text}",
        )

    data = response.json()
    token = (
        data.get("value")
        or data.get("client_secret", {}).get("value")
        or data.get("client_secret")
        or data.get("token")
    )
    if not token:
        raise HTTPException(status_code=502, detail=f"xAI response did not include a token: {data}")

    return {
        "token": token,
        "model": os.getenv("XAI_VOICE_MODEL", "grok-voice-think-fast-1.0"),
        "voice": os.getenv("XAI_VOICE", "rex"),
        "playbackSpeed": float(os.getenv("XAI_PLAYBACK_SPEED", "1.12")),
        "instructions": load_prompt(),
        "sampleRate": 24000,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("APP_HOST", "127.0.0.1"),
        port=int(os.getenv("APP_PORT", "8000")),
        reload=True,
    )
