import os
from typing import List, Dict, Any

from fastapi import FastAPI, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore

PORT = int(os.getenv('PORT', '4007'))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get('/health')
async def health():
    return {"ok": True}


def _client():
    api_key = os.getenv("LLM_API_KEY")
    base_url = os.getenv("LLM_BASE_URL")
    if not (OpenAI and api_key and base_url):
        return None
    return OpenAI(base_url=base_url, api_key=api_key)


@app.post('/chat')
async def chat(
    messages: List[Dict[str, Any]] = Body(...),
    model: str = Body(os.getenv("LLM_MODEL", "gpt-4o-mini")),
    temperature: float = Body(0.2)
):
    try:
        client = _client()
        if client is None:
            return JSONResponse({"error": "LLM not configured"}, status_code=400)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": m.get("role", "user"), "content": m.get("content", "")} for m in messages],
            temperature=temperature,
        )
        text = resp.choices[0].message.content if resp and resp.choices else ""
        return {"model": model, "text": text}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

