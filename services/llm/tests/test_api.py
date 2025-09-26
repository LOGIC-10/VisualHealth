from fastapi.testclient import TestClient

import server

client = TestClient(server.app)


def test_chat_requires_configuration(monkeypatch):
    monkeypatch.delenv('LLM_API_KEY', raising=False)
    monkeypatch.delenv('LLM_BASE_URL', raising=False)
    resp = client.post('/chat', json={'messages': [{'role': 'user', 'content': 'hi'}]})
    assert resp.status_code == 400
    assert resp.json()['error'] == 'LLM not configured'


def test_chat_and_stream_with_stub(monkeypatch):
    class FakeStream:
        def __iter__(self):
            chunk = type('Chunk', (), {})()
            setattr(chunk, 'choices', [type('Choice', (), {
                'delta': type('Delta', (), {'content': 'Hello'})(),
                'finish_reason': None
            })()])
            yield chunk
            chunk2 = type('Chunk', (), {})()
            setattr(chunk2, 'choices', [type('Choice', (), {
                'delta': type('Delta', (), {'content': None})(),
                'finish_reason': 'stop'
            })()])
            yield chunk2

    class FakeCompletions:
        @staticmethod
        def create(**kwargs):
            if kwargs.get('stream'):
                return FakeStream()
            return type('Resp', (), {
                'choices': [type('Choice', (), {
                    'message': type('Message', (), {'content': 'hi there'})()
                })()]
            })

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    monkeypatch.setenv('LLM_API_KEY', 'key')
    monkeypatch.setenv('LLM_BASE_URL', 'http://fake')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setattr(server, '_client', lambda: FakeClient())

    resp = client.post('/chat', json={'messages': [{'role': 'user', 'content': 'hi'}]})
    assert resp.status_code == 200
    assert resp.json()['text'] == 'hi there'

    with client.stream('POST', '/chat_sse', json={'messages': [{'role': 'user', 'content': 'hi'}]}) as stream:
        assert stream.status_code == 200
        lines = [line.decode('utf-8') for line in stream.iter_raw() if line]
    assert any('delta' in line for line in lines)


def test_chat_handles_client_exception(monkeypatch):
    class BrokenCompletions:
        @staticmethod
        def create(**kwargs):
            raise RuntimeError('llm failure')

    class BrokenClient:
        class Chat:
            completions = BrokenCompletions()

        chat = Chat()

    monkeypatch.setenv('LLM_API_KEY', 'key')
    monkeypatch.setenv('LLM_BASE_URL', 'http://fake')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setattr(server, '_client', lambda: BrokenClient())

    resp = client.post('/chat', json={'messages': [{'role': 'user', 'content': 'hello'}]})
    assert resp.status_code == 400
    assert 'error' in resp.json()
