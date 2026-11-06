"""대본 모드 브라우저 시험: 가짜 OpenAI가 정해 둔 말을 차례로 '들은' 것으로 돌려줌.

python3 tests/script_test.py <결과폴더> [대본.txt]
대본 파일을 안 주면 시험용 짧은 대본 사용(실제 설교 대본은 저장소에 넣지 않음).
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_test import HERE, ROOT, free_port, make_speech_wav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kfi_script_test'
os.makedirs(OUT, exist_ok=True)
LINES = ['1. 하나님의 사랑', '오늘 본문은 요한복음 삼장 십육절입니다', '하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니',
         '이는 그를 믿는 자마다 멸망하지 않고 영생을 얻게 하려 하심이라', '우리는 이 사랑을 받은 사람들입니다',
         '그렇다면 우리는 어떻게 살아야 할까요', '2. 사랑의 실천', '이웃을 내 몸과 같이 사랑해야 합니다',
         '말로만 하지 말고 행함과 진실함으로 사랑합시다', '이것이 오늘 말씀의 결론입니다', '함께 기도하겠습니다']
RU = ['1. Любовь Божья', 'Сегодняшний текст — Евангелие от Иоанна 3:16', 'Ибо так возлюбил Бог мир, что отдал Сына Своего Единородного',
      'дабы всякий верующий в Него не погиб, но имел жизнь вечную', 'Мы — люди, получившие эту любовь',
      'Как же нам тогда жить?', '2. Любовь на деле', 'Мы должны любить ближнего, как самого себя',
      'Будем любить не словом, а делом и истиной', 'Таков вывод сегодняшней проповеди', 'Давайте вместе помолимся']
SCRIPT = '\n\n'.join(f'[{i + 1}]\nKO: {k}\nRU: {r}' for i, (k, r) in enumerate(zip(LINES, RU))) + '\n\n용어표\n하나님 = Бог\n요한복음 = Евангелие от Иоанна\n'
HEARD = ['오늘 본문은 요한복음 3장 16절입니다', '하나님이 세상을 이처럼 사랑하셔서 독생자를 주셨으니',
         '여러분 점심은 식당에서 드시면 됩니다',                       # 대본에 없는 말
         '여러분 점심은 식당에서 드시면 됩니다',                       # 바로 앞 말을 인식이 다시 적은 것(걸러야 함)
         '그를 믿는 자마다 멸망치 않고 영생을 얻게 하려 하심이라', '자,',  # 짧은 군말(무시)
         '이웃을 내 몸 같이 사랑해야 합니다',                           # 두 구간 건너뜀
         '행함과 진실함으로 사람합시다']                                 # 인식 오타
EXPECT_CUR = 8   # [9] 말로만 하지 말고…


def main():
    script_text = open(sys.argv[2], encoding='utf-8').read() if len(sys.argv) > 2 else SCRIPT
    heard = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else HEARD
    wav = os.path.join(OUT, 'fake_speech.wav')
    make_speech_wav(wav)
    web_port, api_port = free_port(), free_port()
    web = subprocess.Popen([sys.executable, '-m', 'http.server', str(web_port), '--bind', '127.0.0.1'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    api = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_openai.py'), str(api_port)],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    api.stdout.readline()
    time.sleep(0.5)
    res = {}
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                         f'--use-file-for-fake-audio-capture={wav}', '--no-proxy-server'])
            ctx = br.new_context(viewport={'width': 1366, 'height': 820}, permissions=['microphone'])
            errs = []
            h = ctx.new_page()
            h.on('pageerror', lambda e: errs.append(f'HOST {e}'))
            h.add_init_script("if (!localStorage.getItem('kfi.settings')) {"
                              "localStorage.setItem('kfi.settings', JSON.stringify({mode:'openai', situation:'church', uiLang:'ko', speaking:'left'}));"
                              "localStorage.setItem('kfi.openaiKey', 'sk-good');}")
            h.goto(f'http://127.0.0.1:{web_port}/?apiBase=http://127.0.0.1:{api_port}/v1&shareVia=local')
            h.wait_for_timeout(600)
            # 대본 불러오기(파일 고르기)
            path = os.path.join(OUT, 'script.txt')
            open(path, 'w', encoding='utf-8').write(script_text)
            h.click('#scriptBtn')
            h.set_input_files('#scriptFile', path)
            h.wait_for_timeout(300)
            res['info'] = h.text_content('#scriptInfo')
            res['bar'] = h.text_content('#scriptBar')
            h.screenshot(path=os.path.join(OUT, '1_dialog.png'))
            h.click('#scriptDlg form button')
            # 공유 + 보는 사람(러시아어만)
            h.click('#shareBtn'); h.click('#shareToggle'); h.wait_for_timeout(300)
            h.click('#shareFor button[data-show=ru]')
            link = h.input_value('#shareLink')
            h.click('#shareDlg form button')
            v = ctx.new_page()
            v.set_viewport_size({'width': 412, 'height': 860})
            v.on('pageerror', lambda e: errs.append(f'VIEWER {e}'))
            v.goto(link)
            v.wait_for_timeout(1500)
            # 들릴 말 넣고 시작
            h.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_queue', {{method:'POST', headers:{{Authorization:'Bearer sk-good'}}, body: JSON.stringify({{texts: {json.dumps(heard, ensure_ascii=False)}}})}})")
            h.click('#startBtn')
            t0 = time.time()
            while time.time() - t0 < max(90, len(heard) * 4):
                h.wait_for_timeout(1000)
                left = h.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_log', {{headers:{{Authorization:'Bearer sk-good'}}}}).then(r=>r.json()).then(j=>j.log.filter(x=>x.path==='transcriptions').length)")
                if left >= len(heard) + 1:
                    break
            h.wait_for_timeout(2500)
            h.click('#startBtn')
            h.wait_for_timeout(1500)
            h.screenshot(path=os.path.join(OUT, '2_host_desktop.png'))
            v.wait_for_timeout(1500)
            v.screenshot(path=os.path.join(OUT, '3_viewer_ru.png'))
            q = """() => { const b = (s) => document.querySelector(`.pane-body[data-side=${s}]`);
              const now = (s) => { const e = b(s).querySelector('.seg.now'); return e ? e.textContent : null; };
              return { cur: window.__app.tracker ? window.__app.tracker.cur : null,
                nowLeft: now('left'), nowRight: now('right'),
                past: b('left').querySelectorAll('.seg.past').length,
                adlibLeft: [...b('left').querySelectorAll('.item.adlib .txt')].map(x => x.textContent),
                adlibRight: [...b('right').querySelectorAll('.item.adlib .txt')].map(x => x.textContent),
                leftHidden: getComputedStyle(document.getElementById('paneLeft')).display === 'none' }; }"""
            res['host'] = h.evaluate(q)
            res['bar_end'] = h.text_content('#scriptBar')
            res['viewer_bar'] = v.text_content('#scriptBar')
            res['viewer'] = v.evaluate(q)
            log = h.evaluate(f"fetch('http://127.0.0.1:{api_port}/v1/_log', {{headers:{{Authorization:'Bearer sk-good'}}}}).then(r=>r.json())")['log']
            res['translate_calls'] = sum(1 for x in log if x['path'] == 'responses')
            pr = [x['fields'].get('prompt', [''])[0] for x in log if x['path'] == 'transcriptions']
            res['asr_prompt_has_script'] = any('Prepared sermon script' in x for x in pr)
            gl = [x['body'].get('instructions', '') for x in log if x['path'] == 'responses']
            res['glossary_in_translation'] = any('glossary' in x for x in gl)
            # 처음 위치로 → 예전 파란 글씨가 남지 않아야 함(보는 쪽도)
            h.click('#scriptBtn'); h.click('#scriptReset'); h.click('#scriptDlg form button')
            h.wait_for_timeout(600)
            res['adlibs_after_reset'] = h.evaluate("document.querySelectorAll('.item.adlib').length")
            res['viewer_adlibs_after_reset'] = v.evaluate("document.querySelectorAll('.item.adlib').length")
            h.keyboard.press('ArrowDown'); h.keyboard.press('ArrowDown')
            h.wait_for_timeout(300)
            # 진행자가 ↓ 키로 바로잡기 + 새로고침 후 위치 유지
            h.keyboard.press('ArrowDown')
            h.wait_for_timeout(300)
            res['after_key'] = h.evaluate('window.__app.tracker.cur')  # 처음(-1)에서 ↓ 3번 → 2
            h.reload(); h.wait_for_timeout(800)
            res['after_reload'] = h.evaluate("({cur: window.__app.tracker.cur, now: !!document.querySelector('.seg.now')})")
            res['errors'] = errs
            res['expect_cur'] = EXPECT_CUR if len(sys.argv) <= 2 else None
            br.close()
    finally:
        web.terminate()
        api.terminate()
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
