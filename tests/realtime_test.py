"""OpenAI 실시간(스트리밍) 받아 적기 브라우저 시험 — 가짜 웹소켓 서버(공식 이벤트 이름)로.

python3 tests/realtime_test.py <결과폴더>
경우: 정상 / 몇 문장 실패(그 문장만 기본 방식으로) / 연결 거부(전부 기본 방식으로)
"""
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_test import HERE, ROOT, make_speech_wav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kfi_rt_test'
os.makedirs(OUT, exist_ok=True)


def two_ports():
    while True:
        s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close()
        t = socket.socket()
        try:
            t.bind(('127.0.0.1', p + 1)); t.close(); return p
        except OSError:
            t.close()


def run(name, env_extra, seconds=16, heard=None):
    wav = os.path.join(OUT, 'speech.wav')
    make_speech_wav(wav)
    web_port = two_ports()
    api_port = two_ports()
    web = subprocess.Popen([sys.executable, '-m', 'http.server', str(web_port), '--bind', '127.0.0.1'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    api = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_openai.py'), str(api_port)], env=dict(os.environ, **env_extra),
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    api.stdout.readline(); time.sleep(0.6)
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                         f'--use-file-for-fake-audio-capture={wav}', '--no-proxy-server'])
            ctx = br.new_context(viewport={'width': 412, 'height': 900}, permissions=['microphone'])
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.add_init_script("localStorage.setItem('kfi.settings', JSON.stringify({mode:'openai', situation:'church', uiLang:'ko', speaking:'left'}));"
                               "localStorage.setItem('kfi.openaiKey', 'sk-good');")
            pg.goto(f'http://127.0.0.1:{web_port}/?apiBase=http://127.0.0.1:{api_port}/v1&rtBase=http://127.0.0.1:{api_port + 1}/v1')
            pg.wait_for_timeout(600)
            if heard:
                pg.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_queue', {{method:'POST', headers:{{Authorization:'Bearer sk-good'}}, body: JSON.stringify({{texts: {json.dumps(heard, ensure_ascii=False)}}})}})")
            pg.click('#startBtn')
            interims, statuses = set(), set()
            t0 = time.time()
            while time.time() - t0 < seconds:
                pg.wait_for_timeout(150)
                it = pg.evaluate("[...document.querySelectorAll('.interim')].map(x => x.textContent).join('|')")
                if it: interims.add(it)
                statuses.add(pg.text_content('#statusText'))
            pg.screenshot(path=os.path.join(OUT, f'{name}.png'))
            pg.click('#startBtn'); pg.wait_for_timeout(3000)
            log = pg.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_log', {{headers:{{Authorization:'Bearer sk-good'}}}}).then(r=>r.json())")['log']
            sess = next((x['session'] for x in log if x['path'] == 'rt-session'), None)
            r = {
                'left': pg.evaluate("[...document.querySelectorAll('.pane-body[data-side=left] .item.src .txt')].map(x => x.textContent)"),
                'right_translations': pg.evaluate("document.querySelectorAll('.pane-body[data-side=right] .item.trans').length"),
                'rt_open': [x.get('url') for x in log if x['path'] == 'rt-open'][:1],
                'rt_session': sess and sess.get('audio', {}).get('input'),
                'rt_commits': len([x for x in log if x['path'] == 'rt-commit']),
                'file_transcriptions': len([x for x in log if x['path'] == 'transcriptions']),
                'interim_seen': len(interims),
                'realtime_status_seen': any('⚡' in (x or '') for x in statuses),
                'notice': pg.text_content('#notice'),
                'errors': errs,
            }
            br.close()
            return r
    finally:
        web.terminate(); api.terminate()


if __name__ == '__main__':
    res = {
        'normal': run('normal', {}, heard=['오늘 저녁 이 자리에 와 주셔서 감사합니다', '하나님께서 제 삶을 어떻게 바꾸셨는지 나누고 싶습니다',
                                          '처음 필리핀에 왔을 때 많이 긴장했습니다']),
        'some_fail': run('some_fail', {'MOCK_RT_FAIL_EVERY': '2'}),
        'refused': run('refused', {'MOCK_RT_REJECT': '1'}),
        'no_server': run('no_server', {'MOCK_RT_OFF': '1'}),
    }
    print(json.dumps(res, ensure_ascii=False, indent=1))
