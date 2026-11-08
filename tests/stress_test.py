"""빠르게 쉬지 않고 길게 말할 때 놓치는 말이 없는지(실제 크롬 + 가짜 마이크 + 느리고 가끔 실패하는 가짜 OpenAI).

python3 tests/stress_test.py <결과폴더> [앱 폴더(기본: 이 저장소)]
"""
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_test import HERE, ROOT, free_port  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kfi_stress'
APP = sys.argv[2] if len(sys.argv) > 2 else ROOT
os.makedirs(OUT, exist_ok=True)


def fast_speech_wav(path, sec=75, rate=48000, room=0.006, amp=0.12):
    """앞 2초 조용 → 3~12초 문장 사이에 0.15~0.4초 짧은 숨만 쉬고 계속 말함."""
    rng = np.random.default_rng(7)
    out, speech = [rng.uniform(-room, room, 2 * rate)], 0.0
    total = 2 * rate
    while total < sec * rate:
        n = int(rng.uniform(3, 12) * rate)
        t = (np.arange(n) + total) / rate
        loud = amp * rng.uniform(0.6, 1.4)
        syl = 0.5 + 0.5 * np.sin(2 * np.pi * (5 + 2 * np.sin(t)) * t)
        out.append(loud * syl * np.sin(2 * np.pi * 180 * t) * rng.uniform(0.7, 1.0, n) + rng.uniform(-room, room, n))
        g = int(rng.uniform(0.15, 0.4) * rate)
        out.append(rng.uniform(-room, room, g))
        total += n + g
        speech += n / rate
    pcm = (np.clip(np.concatenate(out), -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
    return speech


def main():
    wav = os.path.join(OUT, 'fast.wav')
    speech = fast_speech_wav(wav)
    web_port, api_port = free_port(), free_port()
    web = subprocess.Popen([sys.executable, '-m', 'http.server', str(web_port), '--bind', '127.0.0.1'], cwd=APP,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    env = dict(os.environ, MOCK_ASR_DELAY='3', MOCK_FAIL_EVERY='5')
    api = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_openai.py'), str(api_port)], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    api.stdout.readline()
    time.sleep(0.5)
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                         f'--use-file-for-fake-audio-capture={wav}%noloop', '--autoplay-policy=no-user-gesture-required',
                                         '--no-proxy-server'])
            ctx = br.new_context(viewport={'width': 412, 'height': 900}, permissions=['microphone'])
            pg = ctx.new_page()
            notices = []
            pg.on('pageerror', lambda e: notices.append(f'PAGEERROR {e}'))
            pg.add_init_script("localStorage.setItem('kfi.settings', JSON.stringify({mode:'openai', situation:'meeting', uiLang:'ko', speaking:'right', readLeft:true}));"
                               "localStorage.setItem('kfi.openaiKey', 'sk-good');")
            pg.goto(f'http://127.0.0.1:{web_port}/?apiBase=http://127.0.0.1:{api_port}/v1')
            pg.wait_for_timeout(600)
            pg.click('#startBtn')
            t0 = time.time()
            while time.time() - t0 < 80:
                pg.wait_for_timeout(1000)
                n = pg.text_content('#notice') or ''
                if n and n not in notices:
                    notices.append(n)
            pg.click('#startBtn')
            pg.wait_for_timeout(15000)   # 밀린 것 마저 처리
            log = pg.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_log', {{headers:{{Authorization:'Bearer sk-good'}}}}).then(r=>r.json())")['log']
            asr = [x for x in log if x['path'] == 'transcriptions']
            ok = [x for x in asr if not x.get('failed')]
            shown = pg.evaluate("document.querySelectorAll('.pane-body .item.src').length")
            pg.screenshot(path=os.path.join(OUT, 'end.png'))
            res = {'speech_sec': round(speech, 1), 'sent_sec': round(sum(x['secs'] for x in ok), 1),
                   'asr_requests': len(asr), 'failed_then_retried': len(asr) - len(ok), 'answered': len(ok),
                   'shown_on_screen': shown, 'notices': notices[:6]}
            br.close()
    finally:
        web.terminate(); api.terminate()
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
