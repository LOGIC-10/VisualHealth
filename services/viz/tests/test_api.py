import numpy as np
from fastapi.testclient import TestClient

import server as viz_server
from server import app

client = TestClient(app)


def test_pcg_quality_pcm_basic():
    payload = {
        "sampleRate": 2000,
        "pcm": [0.0, 0.2, -0.3, 0.5, -0.2, 0.1, 0.0]
    }
    resp = client.post('/pcg_quality_pcm', json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert set(['isHeart', 'qualityOk', 'score']).issubset(data.keys())


def test_spectrogram_pcm_returns_png():
    t = np.linspace(0, 0.5, 1000)
    pcm = np.sin(2 * np.pi * 100 * t).tolist()
    resp = client.post('/spectrogram_pcm', json={
        'sampleRate': 2000,
        'pcm': pcm,
        'width': 400,
        'height': 200
    })
    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'image/png'
    assert resp.content.startswith(b'\x89PNG')


def test_pcg_advanced_includes_timing_headers():
    t = np.linspace(0, 1.0, 2000)
    pcm = np.sin(2 * np.pi * 90 * t).tolist()
    resp = client.post('/pcg_advanced', json={
        'sampleRate': 2000,
        'pcm': pcm,
        'hash': 'testhash'
    })
    assert resp.status_code == 200
    assert 'X-Compute-Time' in resp.headers
    body = resp.json()
    assert 'durationSec' in body
    assert body['events']['s1']


def test_waveform_pcm_rejects_empty_segment():
    resp = client.post('/waveform_pcm', json={
        'sampleRate': 2000,
        'pcm': [],
        'width': 200,
        'height': 100
    })
    assert resp.status_code == 400
    assert resp.json()['error'] == 'empty segment'


def test_features_pcm_basic_metrics():
    pcm = np.sin(np.linspace(0, 4 * np.pi, 2048)).tolist()
    resp = client.post('/features_pcm', json={
        'sampleRate': 2000,
        'pcm': pcm
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data['sampleRate'] == 2000
    assert data['durationSec'] > 0
    assert 'spectralCentroid' in data


def test_features_media_uses_fetch_stub(monkeypatch):
    fake_pcm = np.linspace(-0.5, 0.5, 1024, dtype=np.float32)

    async def fake_fetch(media_id, auth_header):
        return 2000, fake_pcm, None

    monkeypatch.setattr(viz_server, '_fetch_wav_and_decode', fake_fetch)

    resp = client.post('/features_media', json={'mediaId': 'abc'})
    assert resp.status_code == 200
    data = resp.json()
    assert data['sampleRate'] == 2000
    assert data['crestFactor'] >= 1


def test_pcg_quality_media_returns_error_from_fetch(monkeypatch):
    async def fake_fetch(media_id, auth_header):
        return None, None, 'media fetch failed: 404'

    monkeypatch.setattr(viz_server, '_fetch_wav_and_decode', fake_fetch)

    resp = client.post('/pcg_quality_media', json={'mediaId': 'missing'})
    assert resp.status_code == 400
    assert resp.json()['error'] == 'media fetch failed: 404'


def test_spectrogram_media_returns_png(monkeypatch):
    async def fake_fetch(media_id, auth_header):
        t = np.linspace(0, 1.0, 4000, dtype=np.float32)
        pcm = np.sin(2 * np.pi * 120 * t)
        return 4000, pcm, None

    monkeypatch.setattr(viz_server, '_fetch_wav_and_decode', fake_fetch)

    resp = client.post('/spectrogram_media', json={'mediaId': 'abc'})
    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'image/png'
    assert resp.content.startswith(b'\x89PNG')


def test_pcg_advanced_rejects_empty_pcm():
    resp = client.post('/pcg_advanced', json={'sampleRate': 2000, 'pcm': []})
    assert resp.status_code == 400
    assert resp.json()['error'] == 'empty'


def test_pcg_advanced_media_handles_fetch_error(monkeypatch):
    async def fake_fetch(media_id, auth_header):
        return None, None, 'decode failed'

    monkeypatch.setattr(viz_server, '_fetch_wav_and_decode', fake_fetch)

    resp = client.post('/pcg_advanced_media', json={'mediaId': 'broken'})
    assert resp.status_code == 400
    assert resp.json()['error'] == 'decode failed'
