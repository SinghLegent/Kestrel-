"""End-to-end test: real Chromium peers with fake cameras talking over WebRTC."""
import os, subprocess, sys, time, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', 3222))
BASE = f'http://localhost:{PORT}'
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''), flush=True)


def wait_until(fn, timeout=15, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return False


env = dict(os.environ, PORT=str(PORT), ICE_SERVERS='[]', DATA_DIR=tempfile.mkdtemp())
srv = subprocess.Popen(['node', 'server.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1)

STUB = """
navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const x = c.getContext('2d'); let n = 0;
  setInterval(() => { x.fillStyle = '#2a6'; x.fillRect(0,0,640,360); x.fillStyle='#fff'; x.fillText('screen '+(n++), 20, 40); }, 100);
  return c.captureStream(10);
};
"""


def playing(page, selector):
    return page.evaluate("(sel) => [...document.querySelectorAll(sel)].filter(v => v.videoWidth > 0 && !v.paused).length", selector)


try:
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=CHROME, args=[
            '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        errors, csp = [], []

        def ctx(name):
            c = br.new_context(permissions=['camera', 'microphone'], accept_downloads=True)
            c.add_init_script(STUB)
            p = c.new_page()
            p.set_default_timeout(8000)
            p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
            p.on('console', lambda m: csp.append(f'{name}: {m.text}') if 'Content Security Policy' in m.text else None)
            return c, p

        cA, A = ctx('A')
        cB, B = ctx('B')
        cC, C = ctx('C')

        def join(page, code, name, passcode=None):
            page.goto(f'{BASE}/m/{code}')
            page.fill('#pj-name', name)
            if passcode:
                page.fill('#pj-pass', passcode)
            page.click('#pj-join')

        # ---- home + instant meeting ----
        A.goto(BASE + '/')
        check('home renders', A.locator('#new-meeting').is_visible())
        A.click('#new-meeting')
        A.wait_for_selector('#pj-name')
        code = A.url.rsplit('/', 1)[1]
        check('instant meeting gives a code', len(code) == 12 and code[3] == '-', code)
        A.fill('#pj-name', 'Ann')
        A.click('#pj-join')
        A.wait_for_selector('.room')
        join(B, code, 'Bob')
        B.wait_for_selector('.room')
        join(C, code, 'Cy')
        C.wait_for_selector('.room')

        # ---- media flows between all three (mesh) ----
        ok = wait_until(lambda: all(playing(p, '.tile video') >= 3 for p in (A, B, C)), 25)
        check('3 peers all see 3 playing videos (full mesh)', ok, str([playing(p, '.tile video') for p in (A, B, C)]))

        # ---- chat ----
        A.click('[data-ctl=chat]')
        A.fill('input[aria-label="Chat message"]', 'hello team')
        A.keyboard.press('Enter')
        B.click('[data-ctl=chat]')
        check('chat message delivered', wait_until(lambda: 'hello team' in B.inner_text('[data-log=chat]')))
        B.fill('input[aria-label="Chat message"]', 'private to Ann')
        B.select_option('select[aria-label="Send to"]', label='Ann')
        B.keyboard.press('Enter')
        check('private chat reaches recipient', wait_until(lambda: 'private to Ann' in A.inner_text('[data-log=chat]')))
        C.click('[data-ctl=chat]')
        time.sleep(0.5)
        check('private chat hidden from third peer', 'private to Ann' not in C.inner_text('[data-log=chat]'))

        # ---- mute / controls ----
        B.click('[data-ctl=mic]')
        check('self mute shows for others', wait_until(lambda: A.locator('.badge[title=Muted]').count() == 1))
        A.click('[data-ctl=people]')
        A.locator('.person', has_text='Cy').locator('[data-act=mute]').click()
        check('host mute forces mic off', wait_until(lambda: C.evaluate('window.__km.me.mic') is False and C.evaluate('window.__km.local.getAudioTracks()[0].enabled') is False))

        # ---- raise hand, reaction ----
        C.click('[data-ctl=hand]')
        check('raised hand visible to host', wait_until(lambda: A.locator('.badge[title="Hand raised"]').count() == 1))
        B.click('[data-ctl=react]')
        B.locator('.emoji').first.click()
        check('reaction floats on others', wait_until(lambda: A.locator('.float').count() >= 1))

        # ---- screen share ----
        B.click('[data-ctl=share]')
        check('screen share tile appears for others', wait_until(lambda: A.locator('.tile[data-key^="scr:"]').count() == 1 and C.locator('.tile[data-key^="scr:"]').count() == 1, 20))
        check('screen share is the focused tile', wait_until(lambda: A.locator('.tile.main[data-key^="scr:"]').count() == 1))
        check('screen share video plays remotely', wait_until(lambda: playing(A, '.tile[data-key^="scr:"] video') == 1, 20))
        C.click('[data-ctl=share]')
        time.sleep(0.8)
        check('second sharer is refused', C.locator('.toast', has_text='already sharing').count() >= 1)
        B.click('[data-ctl=share]')
        check('stopping share removes tile', wait_until(lambda: A.locator('.tile[data-key^="scr:"]').count() == 0))
        check('grid restored after share', wait_until(lambda: A.locator('.stage.grid').count() == 1))

        # ---- polls ----
        A.click('[data-ctl=polls]')
        A.fill('input[aria-label="Poll question"]', 'Lunch?')
        A.fill('textarea[aria-label="Poll options"]', 'Pizza\nSalad')
        A.click('[data-act=poll-create]')
        B.click('[data-ctl=polls]')
        check('poll reaches participants', wait_until(lambda: 'Lunch?' in B.inner_text('.panel-body')))
        B.locator('[data-opt="0"]').click()
        check('vote is counted', wait_until(lambda: '1 (100%)' in A.inner_text('.panel-body')))

        # ---- security: perms, lock, waiting room ----
        A.click('[data-ctl=security]')
        A.locator('[data-toggle=perm-chat]').uncheck()
        B.click('[data-ctl=chat]')
        check('chat can be disabled', wait_until(lambda: B.evaluate("document.querySelector('input[aria-label=\"Chat message\"]')?.disabled") is True))
        A.locator('[data-toggle=perm-chat]').check()
        A.locator('[data-toggle=waiting]').check()
        cD, D = ctx('D')
        join(D, code, 'Dee')
        check('waiting room holds a new joiner', wait_until(lambda: D.locator('.overlay:not([hidden]) h2', has_text='Waiting').count() == 1))
        A.click('[data-ctl=people]')
        check('host sees waiting joiner', wait_until(lambda: A.locator('.person', has_text='Dee').locator('[data-act=admit]').count() == 1))
        A.locator('.person', has_text='Dee').locator('[data-act=admit]').click()
        check('admitted joiner enters and gets media', wait_until(lambda: playing(D, '.tile video') >= 4, 25), str(playing(D, '.tile video')))
        A.click('[data-ctl=security]')
        A.locator('[data-toggle=waiting]').uncheck()
        A.locator('[data-toggle=lock]').check()
        cE, E = ctx('E')
        join(E, code, 'Eve')
        check('locked meeting rejects joiners', wait_until(lambda: E.locator('.error', has_text='locked').count() == 1))
        A.locator('[data-toggle=lock]').uncheck()

        # ---- remove ----
        A.click('[data-ctl=people]')
        A.locator('.person', has_text='Dee').locator('[data-act=remove]').click()
        check('removed participant is ejected', wait_until(lambda: D.locator('.overlay h2', has_text='removed').count() == 1))

        # ---- breakout rooms ----
        A.click('[data-ctl=breakouts]')
        A.locator('[data-act=bo-create]').click()
        A.locator('[data-act=bo-auto]').click()
        A.locator('[data-act=bo-open]').click()
        check('breakouts move people', wait_until(lambda: B.evaluate('window.__km.me.channel') != 'main' and C.evaluate('window.__km.me.channel') != 'main'))
        chB, chC = B.evaluate('window.__km.me.channel'), C.evaluate('window.__km.me.channel')
        check('auto-assign splits B and C into different rooms', chB != chC, f'{chB} {chC}')
        check('breakout isolates media', wait_until(lambda: playing(B, '.tile video') == 1 and playing(C, '.tile video') == 1))
        A.locator('[data-act=bo-close]').click()
        check('closing breakouts returns everyone', wait_until(lambda: B.evaluate('window.__km.me.channel') == 'main' and C.evaluate('window.__km.me.channel') == 'main'))
        check('media reconnects after breakouts', wait_until(lambda: playing(B, '.tile video') >= 3 and playing(A, '.tile video') >= 3, 25), str((playing(A, '.tile video'), playing(B, '.tile video'))))

        # ---- recording ----
        A.once('dialog', lambda d: d.accept())
        A.click('[data-ctl=record]')
        check('recording notice reaches others', wait_until(lambda: B.locator('.rec-badge:not([hidden])').count() == 1 and 'Ann' in B.inner_text('.rec-badge')))
        time.sleep(3)
        with A.expect_download(timeout=15000) as dl:
            A.click('[data-ctl=record]')
        size = os.path.getsize(dl.value.path())
        check('recording downloads a non-empty webm', size > 5000, str(size))
        check('recording badge clears', wait_until(lambda: B.locator('.rec-badge:not([hidden])').count() == 0))

        # ---- leave / end ----
        C.click('[data-ctl=leave]')
        check('leave shows end card', C.locator('.overlay h2', has_text='left').count() == 1)
        check('others see roster shrink', wait_until(lambda: 'Cy' not in A.inner_text('.stage'), 15))
        A.once('dialog', lambda d: d.accept())
        A.click('[data-ctl=end]')
        check('host ending closes meeting for others', wait_until(lambda: B.locator('.overlay h2', has_text='ended').count() == 1))

        # ---- scheduling + ics + passcode ----
        S = ctx('S')[1]
        S.goto(BASE + '/schedule')
        S.fill('#sch-title', 'Planning')
        S.fill('#sch-pass', 'abc123')
        S.click('#sch-submit')
        S.wait_for_selector('#sch-result')
        scode = S.inner_text('#sch-link').rsplit('/', 1)[1]
        check('schedule shows link + passcode', 'abc123' in S.inner_text('#sch-result'))
        ics = S.request.get(f'{BASE}/api/meetings/{scode}/ics')
        check('ics download valid', ics.ok and 'BEGIN:VEVENT' in ics.text() and 'SUMMARY:Planning' in ics.text())
        S.goto(BASE + '/')
        check('scheduled meeting listed on home', S.locator('.meetings li', has_text='Planning').count() == 1)
        cG, G = ctx('G')
        join(G, scode, 'Gus', 'wrong')
        check('wrong passcode rejected', wait_until(lambda: G.locator('.error', has_text='passcode').count() == 1))
        G.fill('#pj-pass', 'abc123')
        G.click('#pj-join')
        G.wait_for_selector('.room')
        check('right passcode joins', True)

        # ---- webinar ----
        H = ctx('H')[1]
        H.goto(BASE + '/')
        H.click('#new-webinar')
        H.wait_for_selector('#pj-name')
        wcode = H.url.rsplit('/', 1)[1]
        H.fill('#pj-name', 'Host')
        H.click('#pj-join')
        H.wait_for_selector('.room')
        P = ctx('P')[1]
        join(P, wcode, 'Attie')
        P.wait_for_selector('.room')
        check('attendee has no mic/camera controls', P.evaluate('window.__km.local') is None and P.locator('[data-ctl=mic]').count() == 0)
        check('attendee receives host video', wait_until(lambda: playing(P, '.tile video') >= 1, 25), str(playing(P, '.tile video')))
        check('host stage excludes attendees', H.locator('.tile').count() == 1)
        P.click('[data-ctl=qa]')
        P.fill('input[aria-label="Question"]', 'When is the next one?')
        P.keyboard.press('Enter')
        H.click('[data-ctl=qa]')
        check('Q&A question reaches host', wait_until(lambda: 'next one' in H.inner_text('[data-log=qa]')))
        H.locator('input[aria-label="Answer"]').fill('Soon')
        H.locator('.btn', has_text='Answer').click()
        check('answer reaches attendee', wait_until(lambda: 'Soon' in P.inner_text('[data-log=qa]')))
        H.click('[data-ctl=people]')
        H.locator('.person', has_text='Attie').locator('[data-act=panelist]').first.click()
        check('promoted panelist is shown with live video', wait_until(lambda: H.locator('.tile').count() == 2 and playing(H, '.tile video') == 2, 25))
        check('panelist now has mic control', wait_until(lambda: P.locator('[data-ctl=mic]').count() == 1))

        print('\nconsole page errors:', errors or 'none')
        print('CSP violations:', csp or 'none')
        check('no uncaught page errors', not errors, str(errors))
        check('no CSP violations', not csp, str(csp))
        br.close()
finally:
    srv.terminate()

failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
