FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1
WORKDIR /app

# No OS deps needed; use pure-python stack

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY server.py ./
COPY ai_heart.py ./
COPY pcg_hsmm.py ./

EXPOSE 4006
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "4006"]
