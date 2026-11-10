"""Gemini(무료 구간) 연결 방식 브라우저 시험 — 가짜 Gemini 서버로 요금·키 사용 없음.

python3 tests/gemini_test.py <결과폴더>
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_test import HERE, ROOT, free_port, make_speech_wav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kfi_gemini_test'
os.makedirs(OUT, exist_ok=True)


def run(env_extra, settings, seconds=16):
    wav = os.path.join(OUT, 'speech.wav')
    make_speech_wav(wav)
    web_port, api_port = free_port(), free_port()
    web = subprocess.Popen([sys.executable, '-m', 'http.server', str(web_port), '--bind', '127.0.0.1'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    api = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_openai.py'), str(api_port)], env=dict(os.environ, **env_extra),
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    api.stdout.readline(); time.sleep(0.4)
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                         f'--use-file-for-fake-audio-capture={wav}', '--no-proxy-server'])
            ctx = br.new_context(viewport={'width': 412, 'height': 900}, permissions=['microphone', 'clipboard-read', 'clipboard-write'])
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.add_init_script(f"localStorage.setItem('kfi.settings', JSON.stringify({json.dumps(settings)}));")
            url = f'http://127.0.0.1:{web_port}/?geminiBase=http://127.0.0.1:{api_port}/v1beta'
            pg.goto(url); pg.wait_for_timeout(600)
            r = {}
            # 설정: Gemini 고르기 → 틀린 키 시험 → 붙여넣기 → 연결 시험 → 저장
            pg.click('#settingsBtn')
            pg.check('input[name=mode][value=gemini]')
            pg.wait_for_timeout(200)
            r['label'] = pg.text_content('#keyLabelTxt')
            r['guide_gemini_visible'] = pg.is_visible('#guideGemini')
            pg.fill('#keyInput', 'AIza-wrong'); pg.click('#keyTest'); pg.wait_for_timeout(800)
            r['bad_key_msg'] = pg.text_content('#keyMsg')
            pg.evaluate("navigator.clipboard.writeText('AIza-good')"); pg.click('#keyPaste'); pg.wait_for_timeout(200)
            pg.click('#keyTest'); pg.wait_for_timeout(800)
            r['good_key_msg'] = pg.text_content('#keyMsg')
            pg.click('#keySave'); pg.wait_for_timeout(200)
            pg.screenshot(path=os.path.join(OUT, f'settings_{len(env_extra)}.png'))
            pg.click('#settingsDlg .page-head button')
            r['usage'] = pg.text_content('#usage')
            r['auto_enabled'] = not pg.is_disabled('#speakingBar button[data-v=auto]')
            if settings.get('speaking') == 'auto':
                pg.click('#speakingBar button[data-v=auto]')
            pg.click('#startBtn')
            pg.wait_for_timeout(seconds * 1000)
            pg.click('#startBtn'); pg.wait_for_timeout(1500)
            side = lambda d: pg.evaluate(f"[...document.querySelectorAll('.pane-body[data-side={d}] .item')].map(e => e.querySelector('.cap').textContent + ' | ' + e.querySelector('.txt').textContent)")
            r['left'], r['right'] = side('left'), side('right')
            log = pg.evaluate(f"fetch('http://127.0.0.1:{api_port}/_log', {{headers:{{'x-goog-api-key':'AIza-good'}}}}).then(r=>r.json())")['log']
            gm = [x for x in log if x.get('path') == 'gemini']
            r['requests'] = [(x.get('kind'), x.get('model'), x.get('think'), x.get('rejected')) for x in gm]
            r['audio_mime'] = next((x.get('mime') for x in gm if x.get('kind') == 'audio'), None)
            r['sys_has_translate_rules'] = any('Translation rules' in x.get('sys', '') for x in gm)
            r['notice'] = pg.text_content('#notice')
            r['stored_key'] = pg.evaluate("localStorage.getItem('kfi.geminiKey')")
            r['openai_key_untouched'] = pg.evaluate("localStorage.getItem('kfi.openaiKey')")
            r['errors'] = errs
            pg.screenshot(path=os.path.join(OUT, f'running_{len(env_extra)}.png'))
            br.close()
            return r
    finally:
        web.terminate(); api.terminate()


if __name__ == '__main__':
    res = {
        'auto_mode': run({}, {'mode': 'free', 'uiLang': 'ko', 'situation': 'church', 'speaking': 'auto'}),
        'rate_limit_and_no_think': run({'MOCK_GEMINI_RATE_ONCE': '1', 'MOCK_GEMINI_NO_THINK': '1', 'MOCK_GEMINI_NO_38': '1'},
                                       {'mode': 'free', 'uiLang': 'ko', 'situation': 'church', 'speaking': 'left'}, 20),
    }
    print(json.dumps(res, ensure_ascii=False, indent=1))
