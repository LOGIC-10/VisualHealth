import os
from typing import List, Dict, Any

from fastapi import FastAPI, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import json

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


@app.post('/chat_sse')
async def chat_sse(
    messages: List[Dict[str, Any]] = Body(...),
    model: str = Body(os.getenv("LLM_MODEL", "gpt-4o-mini")),
    temperature: float = Body(0.2)
):
    """OpenAI-compatible SSE stream. Yields lines in the form: `data: {json}\n\n` where json has {delta} or {done}.
    """
    try:
        client = _client()
        if client is None:
            return JSONResponse({"error": "LLM not configured"}, status_code=400)

        def gen():
            try:
                stream = client.chat.completions.create(
                    model=model,
                    messages=[{"role": m.get("role", "user"), "content": m.get("content", "")} for m in messages],
                    temperature=temperature,
                    stream=True,
                )
                # Open initial comment to flush connection quickly
                yield ":ok\n\n"
                for chunk in stream:
                    try:
                        ch = chunk.choices[0]
                        # openai>=1.x exposes .delta.content as a string (or None)
                        piece = None
                        delta = getattr(ch, 'delta', None)
                        if delta is not None:
                            # handle both attr object and dict-like delta
                            piece = getattr(delta, 'content', None)
                            if piece is None and isinstance(delta, dict):
                                piece = delta.get('content')
                        # Some compat servers stream under choices[0].message.content
                        if piece is None:
                            msg_obj = getattr(ch, 'message', None)
                            if isinstance(msg_obj, dict):
                                piece = msg_obj.get('content')
                            else:
                                piece = getattr(msg_obj, 'content', None)
                        if piece:
                            yield f"data: {json.dumps({'delta': piece})}\n\n"
                        # Optional: check finish_reason to send done sooner
                        finish = getattr(ch, 'finish_reason', None)
                        if finish:
                            yield f"data: {json.dumps({'finish_reason': finish})}\n\n"
                    except Exception:
                        continue
                yield f"data: {json.dumps({'done': True, 'model': model})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        headers = {
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        return StreamingResponse(gen(), media_type='text/event-stream', headers=headers)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
