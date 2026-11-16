#!/usr/bin/env python3
"""
GhostChat test runner.  Usage:   python tests/run_all.py [--keep]

For every suite it: makes a fresh temporary SQLite database, seeds five test users
(alice = admin, bob, mallory, carol, dave), starts the real server on a free local port,
runs the suite against it, and stops the server. Nothing touches your real database.

Needs:  pip install -r requirements.txt  requests python-socketio[client] pillow
Exit code is 0 only if every check in every suite passes.
"""
import json, os, subprocess, sys, tempfile, time, socket, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, 'tests')
SUITES = ['test_security.py', 'test_moderation.py', 'test_groups.py', 'test_password_reset.py', 'test_admin_2fa.py']
STANDALONE = ['test_retention.py', 'test_hardening2.py']          # builds its own app and database

SEED = r'''
import os, sys, json
sys.path.insert(0, os.environ['GC_ROOT'])
from flask_app import create_app
app = create_app()
from backend.models import db, User, Contact
with app.app_context():
    for n in ('alice', 'bob', 'mallory', 'carol', 'dave'):
        u = User(username=n, email=f'{n}@x.com', is_verified=True); u.set_password('Passw0rd!x'); u.is_admin = (n == 'alice'); db.session.add(u)
    db.session.commit()
    ids = {u.username: u.id for u in User.query.all()}
    for a, b in (('alice', 'bob'), ('carol', 'dave')):
        db.session.add(Contact(user_id=ids[a], contact_id=ids[b])); db.session.add(Contact(user_id=ids[b], contact_id=ids[a]))
    db.session.commit()
    json.dump(ids, open(os.environ['GC_IDS'], 'w'))
'''
SERVE = r'''
import os, sys
sys.path.insert(0, os.environ['GC_ROOT']); os.chdir(os.environ['GC_ROOT'])
import flask_app
flask_app.socketio.run(flask_app.app, host='127.0.0.1', port=int(os.environ['PORT']), allow_unsafe_werkzeug=True)
'''

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

def run_suite(name):
    tmp = tempfile.mkdtemp(prefix='gc_test_')
    port = free_port()
    env = dict(os.environ, GC_ROOT=ROOT, GC_TEST_DB=os.path.join(tmp, 'test.db'), GC_IDS=os.path.join(tmp, 'ids.json'),
               DATABASE_URL='sqlite:///' + os.path.join(tmp, 'test.db'), FLASK_SECRET='x' * 40, ADMIN_EMAILS='alice@x.com',
               PORT=str(port), GC_BASE=f'http://127.0.0.1:{port}', EXTRA_CORS_ORIGINS=f'http://127.0.0.1:{port}',
               TRUSTED_PROXY_HOPS='1', GC_LOG_SECRETS='', ADMIN_2FA_REQUIRED='1' if name == 'test_admin_2fa.py' else '0')
    subprocess.run([sys.executable, '-c', SEED], env=env, cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen([sys.executable, '-c', SERVE], env=env, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(env['GC_BASE'] + '/health', timeout=2); break
            except Exception:
                time.sleep(.5)
        else:
            return False, 'server did not start'
        p = subprocess.run([sys.executable, os.path.join(HERE, name)], env=env, cwd=ROOT, capture_output=True, text=True, timeout=600)
        return p, None
    finally:
        srv.terminate()
        try: srv.wait(5)
        except Exception: srv.kill()

def main():
    failed = []
    for name in SUITES + STANDALONE:
        t = time.time()
        if name in STANDALONE:
            env = dict(os.environ, GC_ROOT=ROOT)
            p = subprocess.run([sys.executable, os.path.join(HERE, name)], env=env, cwd=ROOT, capture_output=True, text=True, timeout=600); err = None
        else:
            p, err = run_suite(name)
        if err or p is False:
            print(f'FAIL  {name}: {err}'); failed.append(name); continue
        out = p.stdout + p.stderr
        bad = [l for l in out.splitlines() if l.startswith('FAIL')]
        npass = sum(1 for l in out.splitlines() if l.startswith('PASS'))
        ok = p.returncode == 0 and not bad and npass > 0
        print(f"{'ok   ' if ok else 'FAIL '} {name}: {npass} checks passed in {time.time() - t:.0f}s")
        for l in bad: print('      ' + l)
        if not ok and not bad: print('      ' + out.strip().splitlines()[-1][:200] if out.strip() else '      no output')
        if not ok: failed.append(name)
    print('\nALL TESTS PASSED' if not failed else f'\nFAILED: {", ".join(failed)}')
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
