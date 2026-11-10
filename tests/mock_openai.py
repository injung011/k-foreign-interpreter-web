"""시험용 가짜 OpenAI 서버 (실제 요금/키 사용 없음). 브라우저 시험을 위해 CORS 허용.

키별 동작:  sk-good 정상 / sk-noquota 잔액 부족(429 insufficient_quota) / 그 외 401
환경 변수:  MOCK_NO_GPT_TRANSCRIBE=1 → gpt-transcribe 없음(404)
            MOCK_ASR_DELAY=초 → 받아 적기 응답 지연 / MOCK_FAIL_EVERY=N → N번째마다 일시 오류(500)
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
QUEUE = []  # 시험에서 정해 둔 '들린 말' 목록(POST /v1/_queue {"texts": [...]}) — 있으면 차례로 돌려줌


def _cors(h):
    h.send_header('Access-Control-Allow-Origin', '*')
    h.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-goog-api-key')
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

    # ---------------- 가짜 Gemini (/v1beta/...) 키: AIza-good
    # MOCK_GEMINI_RATE_ONCE=1 → 첫 번째 생성 요청은 분당 한도(429, 2초 뒤 다시) / MOCK_GEMINI_NO_THINK=1 → thinkingConfig 거부
    def _gemini(self, raw=None):
        if self.headers.get('x-goog-api-key') != 'AIza-good':
            body = json.dumps({'error': {'code': 400, 'message': 'API key not valid. Please pass a valid API key.', 'status': 'INVALID_ARGUMENT',
                                         'details': [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'API_KEY_INVALID'}]}}).encode()
            self.send_response(400); _cors(self); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        if raw is None:
            return _ok(self, {'models': [{'name': 'models/gemini-3.8-flash'}, {'name': 'models/gemini-3.6-flash'}]})
        body = json.loads(raw)
        model = self.path.split('/models/')[1].split(':')[0]
        gen = body.get('generationConfig', {})
        H.gm_n = getattr(H, 'gm_n', 0) + 1
        entry = {'path': 'gemini', 'model': model, 'think': 'thinkingConfig' in gen, 'sys': body.get('systemInstruction', {}).get('parts', [{}])[0].get('text', '')}
        LOG.append(entry)
        def err(code, status, msg, details=None):
            b = json.dumps({'error': {'code': code, 'message': msg, 'status': status, 'details': details or []}}).encode()
            self.send_response(code); _cors(self); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        if os.environ.get('MOCK_GEMINI_NO_THINK') and 'thinkingConfig' in gen:
            entry['rejected'] = 'think'
            return err(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "thinkingConfig"')
        if os.environ.get('MOCK_GEMINI_RATE_ONCE') and not getattr(H, 'gm_rated', False):
            H.gm_rated = True
            entry['rejected'] = 'rate'
            return err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute',
                       [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '2s'}])
        if model == 'gemini-3.8-flash' and os.environ.get('MOCK_GEMINI_NO_38'):
            return err(404, 'NOT_FOUND', 'models/gemini-3.8-flash is not found for API version v1beta')
        parts = body['contents'][0]['parts']
        audio = next((p['inlineData'] for p in parts if 'inlineData' in p), None)
        def reply(text):
            return _ok(self, {'candidates': [{'content': {'parts': [{'text': text}], 'role': 'model'}}]})
        if not audio:                              # 번역만 요청
            entry['kind'] = 'translate'
            return reply('[GM-TR] ' + parts[-1]['text'].split('\n')[-1])
        import base64
        with wave.open(io.BytesIO(base64.b64decode(audio['data']))) as w:
            secs = w.getnframes() / w.getframerate()
        entry['kind'] = 'audio'; entry['secs'] = secs; entry['mime'] = audio.get('mimeType')
        if secs < 1.2:
            return reply(json.dumps({'lang': '', 'text': '', 'translation': ''}))
        langs = gen.get('responseSchema', {}).get('properties', {}).get('lang', {}).get('enum', ['ko'])
        H.gm_k = getattr(H, 'gm_k', 0) + 1
        lg = langs[(H.gm_k - 1) % len(langs)]
        text = {'ko': f'제미니가 받아 적은 한국어 문장 {H.gm_k}', 'ru': f'Русская фраза от Gemini {H.gm_k}',
                'en': f'Gemini heard this English sentence {H.gm_k}'}.get(lg, f'text {lg} {H.gm_k}')
        tr = {'ko': f'[GM-RU] перевод {H.gm_k}', 'ru': f'[GM-KO] 번역 {H.gm_k}', 'en': f'[GM-KO] 번역 {H.gm_k}'}.get(lg, '[GM]')
        return reply(json.dumps({'lang': lg, 'text': text, 'translation': tr}, ensure_ascii=False))

    def do_GET(self):
        if self.path.startswith('/v1beta/'):
            return self._gemini()
        if self.path.endswith('/_log') and self.headers.get('x-goog-api-key') == 'AIza-good':
            return _ok(self, {'log': LOG[-80:]})
        if not self._auth():
            return
        if self.path.endswith('/_log'):
            return _ok(self, {'log': LOG[-50:]})
        if self.path.endswith('/models'):
            _ok(self, {'data': [{'id': 'gpt-transcribe'}, {'id': 'gpt-6-luna'}]})
        else:
            _err(self, 404, 'not_found', 'no route')

    def do_POST(self):
        if self.path.startswith('/v1beta/'):
            n = int(self.headers.get('Content-Length', 0))
            return self._gemini(self.rfile.read(n))
        if not self._auth():
            return
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n)
        if self.path.endswith('/_queue'):
            QUEUE[:] = json.loads(raw).get('texts', [])
            return _ok(self, {'n': len(QUEUE)})
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
        H.asr_n = getattr(H, 'asr_n', 0) + 1
        if os.environ.get('MOCK_ASR_DELAY'):
            import time
            time.sleep(float(os.environ['MOCK_ASR_DELAY']))
        if os.environ.get('MOCK_FAIL_EVERY') and H.asr_n % int(os.environ['MOCK_FAIL_EVERY']) == 0:
            LOG[-1]['failed'] = True
            return _err(self, 500, 'server_error', 'temporary failure')
        if self._key() == 'sk-noquota':
            return _err(self, 429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.')
        if model == 'gpt-transcribe' and os.environ.get('MOCK_NO_GPT_TRANSCRIBE'):
            return _err(self, 404, 'model_not_found', 'The model `gpt-transcribe` does not exist')
        if model == 'gpt-transcribe' and 'language' in fields:
            return _err(self, 400, 'invalid_request_error', 'use languages, not language')
        if secs < 1.2:   # 시험음/짧은 소리
            return _ok(self, {'text': '', 'languages': []})
        if QUEUE:
            text = QUEUE.pop(0)
            lang = 'ko' if any('\uac00' <= c <= '\ud7a3' for c in text) else 'ru'
            out = {'text': text}
            if model == 'gpt-transcribe':
                out['languages'] = [{'code': lang}]
            return _ok(self, out)
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
