"""시험용 가짜 OpenAI 서버 (실제 요금/키 사용 없음). 브라우저 시험을 위해 CORS 허용.

키별 동작:  sk-good 정상 / sk-noquota 잔액 부족(429 insufficient_quota) / 그 외 401
환경 변수:  MOCK_NO_GPT_TRANSCRIBE=1 → gpt-transcribe 없음(404)
            MOCK_NO_LUNA=1 → gpt-6-luna 없음
"""
import io
import json
import os
import threading
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = []   # 받은 요청 기록(시험에서 확인)


def _cors(h):
    h.send_header('Access-Control-Allow-Origin', '*')
    h.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    h.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')


def _err(h, status, code, msg):
    body = json.dumps({'error': {'message': msg, 'type': code, 'code': code}}).encode()
    h.send_response(status)
    _cors(h)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Content-Length', str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def _ok(h, obj):
    body = json.dumps(obj, ensure_ascii=False).encode()
    h.send_response(200)
    _cors(h)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Content-Length', str(len(body)))
    h.end_headers()
    h.wfile.write(body)


class H(BaseHTTPRequestHandler):
    counter = [0]

    def log_message(self, *a):
        pass

    def _key(self):
        return (self.headers.get('Authorization') or '').replace('Bearer ', '')

    def _auth(self):
        k = self._key()
        if k not in ('sk-good', 'sk-noquota'):
            _err(self, 401, 'invalid_api_key', 'Incorrect API key provided')
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        _cors(self)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._auth():
            return
        if self.path.endswith('/models'):
            _ok(self, {'data': [{'id': 'gpt-transcribe'}, {'id': 'gpt-6-luna'}]})
        else:
            _err(self, 404, 'not_found', 'no route')

    def do_POST(self):
        if not self._auth():
            return
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n)
        if self.path.endswith('/audio/transcriptions'):
            return self._transcribe(raw)
        if self.path.endswith('/responses'):
            return self._responses(json.loads(raw))
        if self.path.endswith('/audio/speech'):
            return self._speech(json.loads(raw))
        _err(self, 404, 'not_found', 'no route')

    def _transcribe(self, raw):
        msg = BytesParser(policy=default).parsebytes(
            b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + raw)
        fields, wav_ok, secs = {}, False, 0.0
        for part in msg.iter_parts():
            name = part.get_param('name', header='content-disposition')
            data = part.get_payload(decode=True)
            if name == 'file':
                with wave.open(io.BytesIO(data)) as w:
                    wav_ok = w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
                    secs = w.getnframes() / 16000
            else:
                fields.setdefault(name, []).append(data.decode('utf-8'))
        model = fields.get('model', [''])[0]
        LOG.append({'path': 'transcriptions', 'fields': fields, 'wav_ok': wav_ok, 'secs': secs})
        if self._key() == 'sk-noquota':
            return _err(self, 429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.')
        if model == 'gpt-transcribe' and os.environ.get('MOCK_NO_GPT_TRANSCRIBE'):
            return _err(self, 404, 'model_not_found', 'The model `gpt-transcribe` does not exist')
        if model == 'gpt-transcribe' and 'language' in fields:
            return _err(self, 400, 'invalid_request_error', 'use languages, not language')
        if secs < 1.2:   # 시험음/짧은 소리
            return _ok(self, {'text': '', 'languages': []})
        H.counter[0] += 1
        langs = fields.get('languages[]') or fields.get('language') or ['ko', 'ru']
        lang = langs[(H.counter[0] - 1) % len(langs)]
        text = {'ko': f'김인중 형제입니다. 다 같이 교제하는 시간입니다 {H.counter[0]}',
                'ru': f'Здравствуйте, братья и сёстры {H.counter[0]}',
                'en': f'Welcome brothers and sisters {H.counter[0]}',
                'es': f'Bienvenidos hermanos y hermanas {H.counter[0]}',
                'ja': f'兄弟姉妹の皆さん、ようこそ {H.counter[0]}'}.get(lang, f'text {lang}')
        out = {'text': text}
        if model == 'gpt-transcribe':
            out['languages'] = [{'code': lang}]
        return _ok(self, out)

    def _speech(self, body):
        LOG.append({'path': 'speech', 'body': body})
        if self._key() == 'sk-noquota':
            return _err(self, 429, 'insufficient_quota', 'You exceeded your current quota')
        import numpy as np
        n = 24000 // 2   # 0.5초
        pcm = (0.2 * np.sin(2 * np.pi * 440 * np.arange(n) / 24000) * 32767).astype('<i2').tobytes()
        bio = io.BytesIO()
        with wave.open(bio, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(pcm)
        data = bio.getvalue()
        self.send_response(200)
        _cors(self)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _responses(self, body):
        LOG.append({'path': 'responses', 'body': body})
        model = body.get('model')
        if 'briefing' in body.get('instructions', ''):
            js = json.dumps({'summary': 'Testimony evening of Brother Kim In-jung.',
                             'keywords': ['김인중', '블라디보스토크', 'Ким Ин Джун'],
                             'glossary': [['김인중 형제', 'брат Ким Ин Джун'], ['수련회', 'ретрит']]}, ensure_ascii=False)
            return _ok(self, {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '```json\n' + js + '\n```'}]}],
                              'usage': {'input_tokens': 5000, 'output_tokens': 300}})
        if model == 'gpt-6-luna' and os.environ.get('MOCK_NO_LUNA'):
            return _err(self, 404, 'model_not_found', f'The model `{model}` does not exist')
        if self._key() == 'sk-noquota':
            return _err(self, 429, 'insufficient_quota', 'You exceeded your current quota')
        text = body['input'].split(':\n')[-1].split('\n\n')[-1]
        tgt = 'RU' if 'into Russian' in body['instructions'] else 'KO'
        if 'into English' in body['instructions']:
            tgt = 'EN'
        if 'into Japanese' in body['instructions']:
            tgt = 'JA'
        strong = 'MUST be written' in body['input']
        if os.environ.get('MOCK_ECHO') and tgt == 'KO' and (not strong or os.environ.get('MOCK_ECHO') == 'always'):
            out = text                                   # 원문을 그대로 돌려주는 오류 흉내
        else:
            out = {'KO': '[AI-KO] 번역된 한국어 문장입니다', 'RU': '[AI-RU] Переведённое предложение',
                   'EN': '[AI-EN] Translated English sentence', 'JA': '[AI-JA] 翻訳された日本語の文です'}[tgt]
        return _ok(self, {'output': [{'type': 'reasoning', 'summary': []},
                                     {'type': 'message', 'content': [{'type': 'output_text', 'text': out}]}],
                          'usage': {'input_tokens': 300, 'output_tokens': 40}})


def start(port=0):
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}/v1'


if __name__ == '__main__':
    import sys
    srv, url = start(int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(url, flush=True)
    threading.Event().wait()
