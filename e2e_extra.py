"""Extra end-to-end checks: speaker highlight, pin/spotlight, co-host, permissions, breakout extras."""
import os, subprocess, sys, time, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', 3666)); BASE = f'http://localhost:{PORT}'
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
results = []
def check(n, ok, d=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (f'  [{d}]' if d and not ok else ''), flush=True)
def wait_until(fn, t=15):
    end = time.time() + t
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(.25)
    return False
env = dict(os.environ, PORT=str(PORT), ICE_SERVERS='[]', DATA_DIR=tempfile.mkdtemp())
srv = subprocess.Popen(['node', 'server.mjs'], cwd=ROOT, env=env); time.sleep(1)
def playing(p, s): return p.evaluate("(s)=>[...document.querySelectorAll(s)].filter(v=>v.videoWidth>0&&!v.paused).length", s)
try:
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=CHROME, args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--no-sandbox'])
        errs = []
        def mk(n):
            c = br.new_context(permissions=['camera','microphone']); p = c.new_page(); p.set_default_timeout(8000)
            p.on('pageerror', lambda e: errs.append(f'{n}:{e}')); return p
        def join(p, code, name):
            p.goto(f'{BASE}/m/{code}'); p.fill('#pj-name', name); p.click('#pj-join'); p.wait_for_selector('.room')
        A, B, C = mk('A'), mk('B'), mk('C')
        A.goto(BASE + '/'); A.click('#new-meeting'); A.wait_for_selector('#pj-name'); code = A.url.rsplit('/', 1)[1]
        A.fill('#pj-name', 'Ann'); A.click('#pj-join'); A.wait_for_selector('.room')
        join(B, code, 'Bob'); join(C, code, 'Cy')
        wait_until(lambda: playing(A, '.tile video') >= 3, 25)

        check('active speaker is highlighted', wait_until(lambda: B.locator('.tile.speaking').count() >= 1, 15))
        # pin
        B.locator('.tile[data-key^="cam:"]', has_text='Cy').click()
        check('click pins a tile as main', wait_until(lambda: B.locator('.tile.main', has_text='Cy').count() == 1))
        B.locator('.tile.main').click()
        check('click again unpins', wait_until(lambda: B.locator('.tile.main').count() == 0))
        # spotlight
        A.click('[data-ctl=people]')
        A.locator('.person', has_text='Bob').locator('[data-act=spotlight]').click()
        check('host spotlight focuses everyone on one tile', wait_until(lambda: C.locator('.tile.main', has_text='Bob').count() == 1 and A.locator('.tile.main', has_text='Bob').count() == 1))
        A.locator('.person', has_text='Bob').locator('[data-act=spotlight]').click()
        check('spotlight can be removed', wait_until(lambda: C.locator('.tile.main').count() == 0))
        # co-host
        A.locator('.person', has_text='Bob').locator('[data-act=cohost]').click()
        check('co-host gets moderation controls', wait_until(lambda: B.locator('[data-ctl=security]').count() == 1 and B.locator('[data-ctl=record]').count() == 1))
        B.click('[data-ctl=people]')
        B.locator('.person', has_text='Cy').locator('[data-act=mute]').click()
        check('co-host can mute others', wait_until(lambda: C.evaluate('window.__km.me.mic') is False))
        check('co-host cannot remove the host', B.locator('.person', has_text='Ann').locator('[data-act=remove]').count() == 0)
        A.locator('.person', has_text='Bob').locator('[data-act=cohost]').click()
        check('co-host can be revoked', wait_until(lambda: B.locator('[data-ctl=security]').count() == 0))
        # permissions: share blocked
        A.click('[data-ctl=security]')
        A.locator('[data-toggle=perm-share]').uncheck()
        C.click('[data-ctl=share]')
        check('blocked screen share is refused', wait_until(lambda: C.locator('.toast', has_text='turned off').count() >= 1 and C.evaluate('window.__km.screen') is None))
        A.locator('[data-toggle=perm-share]').check()
        # mute all
        B.evaluate("window.__km.me.mic") ; 
        A.click('[data-ctl=people]'); A.locator('.btn', has_text='Mute all').click()
        check('mute all silences participants', wait_until(lambda: B.evaluate('window.__km.me.mic') is False and C.evaluate('window.__km.me.mic') is False))
        # breakouts: broadcast + ask for help
        A.click('[data-ctl=breakouts]')
        A.locator('[data-act=bo-create]').click(); A.locator('[data-act=bo-auto]').click(); A.locator('[data-act=bo-open]').click()
        wait_until(lambda: B.evaluate('window.__km.me.channel') != 'main')
        A.fill('input[placeholder="Message to all rooms"]', 'Five minutes left')
        A.locator('.btn', has_text='Broadcast').click()
        check('broadcast reaches breakout rooms', wait_until(lambda: 'Five minutes left' in B.inner_text('.banner') and 'Five minutes left' in C.inner_text('.banner')))
        B.click('[data-ctl=help]')
        check('ask-for-help notifies host', wait_until(lambda: A.locator('.toast', has_text='asks for help').count() >= 1))
        B.click('[data-ctl=leave-room]')
        check('participant can leave breakout on their own', wait_until(lambda: B.evaluate('window.__km.me.channel') == 'main'))
        # host hand lower
        B.click('[data-ctl=hand]')
        A.click('[data-ctl=people]')
        A.locator('.person', has_text='Bob').locator('[data-act=lower-hand]').click()
        check('host can lower a raised hand', wait_until(lambda: B.evaluate('window.__km.me.hand') is not True))
        check('no uncaught page errors', not errs, str(errs))
        br.close()
finally:
    srv.terminate()
print(f'\n{sum(results)}/{len(results)} passed'); sys.exit(0 if all(results) else 1)
