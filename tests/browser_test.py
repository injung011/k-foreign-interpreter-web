"""실제 크롬(Playwright)으로 웹앱 전체 흐름 시험.

가짜 마이크: 크롬에 '말소리 비슷한 소리' WAV 파일을 마이크 입력으로 넣음
가짜 OpenAI: tests/mock_openai.py (요금·키 사용 없음)

python tests/browser_test.py <결과폴더>
"""
import json
import os
import socket
import subprocess
import sys
import time
import wave

import numpy as np
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kfi_web_test'
os.makedirs(OUT, exist_ok=True)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_speech_wav(path, rate=48000):
    parts = []
    t = 0
    for sec, amp in [(1.0, 0.0), (2.0, 0.25), (1.2, 0.0), (1.5, 0.25)] * 4:
        n = int(sec * rate)
        tt = (np.arange(n) + t) / rate
        sig = amp * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * tt)) * np.sin(2 * np.pi * 220 * tt)
        sig += np.random.default_rng(t).standard_normal(n) * 0.002
        parts.append(sig)
        t += n
    pcm = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main():
    wav = os.path.join(OUT, 'fake_speech.wav')
    make_speech_wav(wav)
    web_port, api_port = free_port(), free_port()
    web = subprocess.Popen([sys.executable, '-m', 'http.server', str(web_port), '--bind', '127.0.0.1'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    api = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_openai.py'), str(api_port)],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    api.stdout.readline()
    time.sleep(0.5)
    results = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                f'--use-file-for-fake-audio-capture={wav}', '--autoplay-policy=no-user-gesture-required',
                '--no-proxy-server'])
            for name, viewport, settings in [
                ('phone_openai', {'width': 412, 'height': 915},
                 {'mode': 'openai', 'situation': 'church', 'note': '선교 보고회', 'readRight': True, 'fontSize': 22}),
                ('desktop_openai', {'width': 1366, 'height': 768},
                 {'mode': 'openai', 'situation': 'hospital', 'note': '소아과 진료', 'fontSize': 26}),
            ]:
                ctx = browser.new_context(viewport=viewport, permissions=['microphone'])
                logs = []
                page = ctx.new_page()
                page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
                page.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
                page.add_init_script(f"""
                    localStorage.setItem('kfi.settings', JSON.stringify({json.dumps(settings)}));
                    localStorage.setItem('kfi.openaiKey', 'sk-good');
                """)
                page.goto(f'http://127.0.0.1:{web_port}/?apiBase=http://127.0.0.1:{api_port}/v1')
                page.wait_for_timeout(800)
                page.screenshot(path=os.path.join(OUT, f'{name}_0_start.png'))
                page.click('#startBtn')
                page.wait_for_timeout(16000)
                page.screenshot(path=os.path.join(OUT, f'{name}_1_running.png'))
                state = page.evaluate("""() => {
                    const side = (d) => [...document.querySelectorAll(`.pane-body[data-side=${d}] .item`)].map(e =>
                        e.querySelector('.cap').textContent + ' | ' + e.querySelector('.txt').textContent);
                    return {left: side('left'), right: side('right'), status: document.getElementById('statusText').textContent,
                            usage: document.getElementById('usage').textContent,
                            warn: document.getElementById('warn').textContent,
                            running: window.__app.engine.running,
                            history: JSON.parse(localStorage.getItem('kfi.history') || '[]').length};
                }""")
                page.click('#startBtn')   # 멈춤
                page.wait_for_timeout(500)
                state['running_after_stop'] = page.evaluate('window.__app.engine.running')
                page.click('#settingsBtn')
                page.wait_for_timeout(400)
                page.screenshot(path=os.path.join(OUT, f'{name}_2_settings.png'))
                lg = page.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_log', {{headers: {{Authorization: 'Bearer sk-good'}}}}).then(r => r.json())")['log']
                prompts = [x['fields'].get('prompt', ['(none)'])[0] for x in lg if x.get('path') == 'transcriptions']
                state['asr_prompts'] = prompts[-2:]
                state['logs'] = [lg for lg in logs if 'error' in lg.lower()][:10]
                results[name] = state
                ctx.close()

            # 무료 모드 화면(크롬 음성 인식은 이 시험 환경에서 동작하지 않으므로 화면만)
            ctx = browser.new_context(viewport={'width': 412, 'height': 915})
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{web_port}/')
            page.wait_for_timeout(600)
            page.screenshot(path=os.path.join(OUT, 'phone_free_welcome.png'))
            page.click('#sitBtn')
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(OUT, 'phone_situation.png'))
            results['free'] = page.evaluate("""() => ({
                autoDisabled: document.querySelector('#speakingBar button[data-v=auto]').disabled,
                welcome: !!document.querySelector('.welcome')})""")
            ctx.close()

            # 보기 전용 공유(같은 브라우저 local 전송) + 한 창 크게 + 화면 언어 + 붙여넣기
            ctx = browser.new_context(viewport={'width': 412, 'height': 915},
                                      permissions=['microphone', 'clipboard-read', 'clipboard-write'])
            host = ctx.new_page()
            host.on('pageerror', lambda e: print('HOST PAGEERROR', e))
            host.add_init_script("if (!localStorage.getItem('kfi.settings')) {"
                                 "localStorage.setItem('kfi.settings', JSON.stringify({mode:'openai', situation:'church', uiLang:'ko'}));"
                                 "localStorage.setItem('kfi.openaiKey', 'sk-good');}")
            host.goto(f'http://127.0.0.1:{web_port}/?apiBase=http://127.0.0.1:{api_port}/v1&shareVia=local')
            host.wait_for_timeout(600)
            host.click('#shareBtn')
            host.click('#shareToggle')
            host.wait_for_timeout(400)
            host.click('#shareFor button[data-show=ru]')
            link = host.input_value('#shareLink')
            host.screenshot(path=os.path.join(OUT, 'share_dialog.png'))
            host.wait_for_timeout(100)
            host.click('#shareDlg form button')
            viewer = ctx.new_page()
            viewer.on('pageerror', lambda e: print('VIEWER PAGEERROR', e))
            viewer.goto(link)
            viewer.wait_for_timeout(800)
            host.click('#startBtn')
            host.wait_for_timeout(14000)
            host.click('#startBtn')
            host.wait_for_timeout(5500)
            host.screenshot(path=os.path.join(OUT, 'host_phone_ko.png'))
            viewer.screenshot(path=os.path.join(OUT, 'viewer_phone.png'))
            vs = viewer.evaluate("""() => ({
                link: location.search,
                viewerClass: document.body.classList.contains('viewer'),
                bottomHidden: getComputedStyle(document.getElementById('bottomBar')).display === 'none',
                left: document.querySelectorAll('.pane-body[data-side=left] .item').length,
                right: document.querySelectorAll('.pane-body[data-side=right] .item').length})""")
            vs['hostItems'] = host.evaluate("document.querySelectorAll('.pane-body .item').length")
            vs['shareBar'] = host.text_content('#shareBar')
            vs['onlyRightFromLink'] = viewer.evaluate("getComputedStyle(document.getElementById('paneLeft')).display === 'none'")
            viewer.click('#bothBtn')
            viewer.wait_for_timeout(300)
            vs['bothAfterTap'] = viewer.evaluate("getComputedStyle(document.getElementById('paneLeft')).display !== 'none'")
            viewer.wait_for_timeout(5500)
            vs['staysBoth'] = viewer.evaluate("getComputedStyle(document.getElementById('paneLeft')).display !== 'none'")
            host.click('#settingsBtn')
            host.select_option('#uiLangSel', 'ru')
            host.wait_for_timeout(300)
            vs['ruStart'] = host.text_content('#startBtn')
            host.evaluate("navigator.clipboard.writeText('sk-pasted-1234567890')")
            host.click('#keyPaste')
            host.wait_for_timeout(300)
            vs['pasted'] = host.input_value('#keyInput')
            host.screenshot(path=os.path.join(OUT, 'settings_ru.png'))
            results['share'] = vs
            ctx.close()

            # 서버(Supabase)에 못 붙으면 같은 기기 공유로 자동 전환되는지(이 시험 환경은 외부 접속 차단)
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{web_port}/')
            page.wait_for_timeout(500)
            page.click('#shareBtn')
            page.click('#shareToggle')
            page.wait_for_function('window.__app.share.active', timeout=40000)
            page.wait_for_timeout(300)
            results['fallback'] = page.evaluate("({kind: window.__app.share.kind, notice: document.getElementById('notice').textContent, link: document.getElementById('shareLink').value.split('?')[1]})")
            ctx.close()

            # 화면 언어: 영어 기기여도 한국어로 시작, 🌐 버튼으로 바꾸기
            ctx = browser.new_context(locale='en-US', viewport={'width': 412, 'height': 915})
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{web_port}/')
            page.wait_for_timeout(500)
            ui = {'enDevice': page.text_content('#startBtn'), 'btn': page.text_content('#uiBtn')}
            page.click('#uiBtn')
            page.click('#uiList button:has-text("Русский")')
            page.wait_for_timeout(200)
            ui['afterRu'] = page.text_content('#startBtn')
            page.screenshot(path=os.path.join(OUT, 'ui_ru.png'))
            page.reload()
            page.wait_for_timeout(500)
            ui['afterReload'] = page.text_content('#startBtn')
            ctx.close()
            ctx = browser.new_context(locale='ru-RU')
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{web_port}/')
            page.wait_for_timeout(400)
            ui['ruDevice'] = page.text_content('#startBtn')
            ctx.close()
            results['ui'] = ui

            # 악성 링크 방지: 배포 주소처럼 localhost가 아닌 곳에서는 apiBase 무시되는지(함수 직접 확인)
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{web_port}/?apiBase=https://evil.example/v1')
            results['apiBase_guard'] = page.evaluate("import('./js/store.js').then(m => m.apiBase())")
            ctx.close()
            browser.close()
    finally:
        web.terminate()
        api.terminate()
    print(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
