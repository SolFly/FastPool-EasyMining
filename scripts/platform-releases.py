#!/usr/bin/env python3
"""Build, smoke-test and collect native CGO executables without private account data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ('linux-amd64', 'linux-arm64', 'windows-amd64', 'windows-arm64', 'darwin-amd64', 'darwin-arm64')
OUT = ROOT / 'dist/release'


def version():
    value = re.search(r'const Version = "([^"]+)"', (ROOT / 'internal/controller/value.go').read_text())[1]
    assert re.fullmatch(r'\d+\.\d+\.\d+-go', value), 'Invalid version'
    assert json.loads((ROOT / 'package.json').read_text())['version'] == value
    assert re.search(r"export const VERSION = '([^']+)'", (ROOT / 'public/core.mjs').read_text())[1] == value
    assert (ROOT / f'docs/releases/v{value}.md').is_file(), 'Missing release notes'
    ref = os.environ.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/'):
        assert ref == 'refs/tags/v' + value, 'Tag and application version differ'
    return value


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def executable(target):
    return 'fastpool-easymining-' + target + ('.exe' if target.startswith('windows-') else '')


def execute(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, cwd=ROOT, **kwargs)


def capture(args, **kwargs):
    return execute(args, capture_output=True, text=True, encoding='utf-8', errors='replace', **kwargs).stdout.strip()


def check_header(binary, target):
    data = binary.read_bytes()
    operating_system, arch = target.split('-')
    if operating_system == 'linux':
        assert data[:6] == b'\x7fELF\x02\x01', 'Expected 64-bit little-endian ELF'
        assert struct.unpack_from('<H', data, 18)[0] == {'amd64': 62, 'arm64': 183}[arch], 'Wrong ELF architecture'
    elif operating_system == 'windows':
        assert data[:2] == b'MZ', 'Expected a Windows executable'
        offset = struct.unpack_from('<I', data, 60)[0]
        assert data[offset:offset + 4] == b'PE\x00\x00'
        assert struct.unpack_from('<H', data, offset + 4)[0] == {'amd64': 0x8664, 'arm64': 0xaa64}[arch], 'Wrong PE architecture'
    else:
        assert data[:4] == b'\xcf\xfa\xed\xfe', 'Expected 64-bit Mach-O'
        assert struct.unpack_from('<I', data, 4)[0] == {'amd64': 0x1000007, 'arm64': 0x100000c}[arch], 'Wrong Mach-O architecture'


def smoke(binary, release_version):
    binary = binary.resolve()
    assert capture([binary, '--version']) == f'FastPool EasyMining {release_version} · Go'
    with tempfile.TemporaryDirectory(prefix='easymining-smoke-') as temporary:
        folder = Path(temporary)
        data = folder / 'data'
        previous_key = None
        for cycle in range(2):
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            env = {k: v for k, v in os.environ.items() if not k.startswith('NICEHASH_')}
            env.update(HOST='127.0.0.1', PORT=str(port), DATA_DIR=str(data), PUBLIC_URL='', APP_PASSWORD='ci-synthetic-password-only')
            # Native Windows tests must not borrow compiler DLLs from MSYS2's PATH.
            env['PATH'] = (os.path.join(env.get('SystemRoot', r'C:\Windows'), 'System32') + os.pathsep + env.get('SystemRoot', r'C:\Windows')) if os.name == 'nt' else '/usr/bin:/bin'
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with (folder / f'run-{cycle}.log').open('wb') as log:
                process = subprocess.Popen([str(binary)], cwd=folder, env=env, stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        if process.poll() is not None:
                            details = (folder / f'run-{cycle}.log').read_text(encoding='utf-8', errors='replace')[-6000:]
                            raise RuntimeError(f'Executable exited before health check ({process.returncode}): {details}')
                        try:
                            with opener.open(f'http://127.0.0.1:{port}/healthz', timeout=1) as response:
                                health = json.load(response)
                            assert health == {'ok': True, 'runtime': 'go', 'version': release_version}, health
                            break
                        except (OSError, urllib.error.URLError):
                            if time.monotonic() > deadline:
                                raise RuntimeError('Startup health check timed out')
                            time.sleep(0.25)
                finally:
                    if process.poll() is None:
                        process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            key = (data / 'master.key').read_bytes()
            assert len(key) == 32 and (previous_key is None or key == previous_key), 'Instance key changed on restart'
            previous_key = key
            with sqlite3.connect(data / 'controller.sqlite') as database:
                tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                assert {'kv', 'orders', 'strategies', 'rewards'} <= tables, 'SQLite ledger not initialized'
    print('Native startup, SQLite and persisted-key restart checks passed.', flush=True)


def package(target, binary):
    release_version = version()
    check_header(binary, target)
    smoke(binary, release_version)
    OUT.mkdir(parents=True, exist_ok=True)
    destination = OUT / executable(target)
    if binary.resolve() != destination.resolve():
        shutil.copyfile(binary, destination)
    destination.chmod(0o755)
    archive = OUT / f'fastpool-easymining-v{release_version}-{target}.zip'
    prefix = f'FastPool-EasyMining-v{release_version}-{target}/'
    run_command = '.\\' + destination.name if target.startswith('windows-') else './' + destination.name
    copy_command = 'Copy-Item .env.example .env' if target.startswith('windows-') else 'cp .env.example .env'
    permission_command = '' if target.startswith('windows-') else f'chmod +x {destination.name}\n'
    notes = f'''FastPool EasyMining {release_version} — {target}

Extract this entire folder and open a terminal/PowerShell in it.
{copy_command}
{permission_command}{run_command} --env-file=.env

Open http://localhost:8080 and use the setup token printed in this terminal.
The web UI is embedded. Keep the process running while buying or syncing.
An upgrade must retain the existing data directory and matching master.key.
Never put credentials or the data directory in a public repository.

Windows and macOS executables are unsigned (macOS: not notarized). OS approval
may be required. No third-party SQLite server or Node.js runtime is needed.
Full setup, limits, backups and updates:
https://github.com/SolFly/FastPool-EasyMining#readme
'''
    entries = {destination.name: destination.read_bytes(), 'START-HERE.txt': notes.encode('utf-8')}
    entries.update({name: (ROOT / name).read_bytes() for name in ['LICENSE', '.env.example', 'config.example.json']})
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, contents in entries.items():
            info = zipfile.ZipInfo(prefix + name, date_time=(2026, 11, 2, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if name == destination.name else 0o644) << 16
            zipped.writestr(info, contents)
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        assert zipped.read(prefix + destination.name) == destination.read_bytes()
    record = {'target': target, 'version': release_version, 'commit': os.environ.get('GITHUB_SHA', ''),
              'runner': platform.platform(), 'native_smoke_test': 'passed', 'sqlite_restart': 'passed',
              'files': {p.name: digest(p) for p in [destination, archive]}}
    (OUT / f'TARGET-{target}.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    print(f'Packaged {target}: {archive.name}', flush=True)


def build(target):
    release_version = version()
    operating_system, arch = target.split('-')
    host_os = {'win32': 'windows', 'darwin': 'darwin', 'linux': 'linux'}[sys.platform]
    host_arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine().lower()]
    assert (operating_system, arch) == (host_os, host_arch), 'A native matching runner is required'
    env = dict(os.environ, CGO_ENABLED='1', GOOS=operating_system, GOARCH=arch)
    execute(['go', 'test', '-mod=vendor', '-count=1', './...'], env=env)
    binary = ROOT / 'bin' / executable(target)
    binary.parent.mkdir(exist_ok=True)
    if operating_system == 'linux':
        image = 'easymining-native:' + os.environ.get('GITHUB_SHA', 'local')
        execute(['docker', 'build', '--tag', image, '.'])
        container = capture(['docker', 'create', image])
        try:
            execute(['docker', 'cp', container + ':/usr/local/bin/easymining', binary])
        finally:
            subprocess.run(['docker', 'rm', '-f', container], check=False, stdout=subprocess.DEVNULL)
        binary.chmod(0o755)
        assert 'statically linked' in capture(['file', binary]), 'Expected static Linux executable'
    else:
        flags = '-s -w' + (' -linkmode external -extldflags -static' if operating_system == 'windows' else '')
        execute(['go', 'build', '-mod=vendor', '-buildvcs=false', '-trimpath', '-tags', 'netgo osusergo sqlite_omit_load_extension', '-ldflags', flags, '-o', binary, './cmd/easymining'], env=env)
        if operating_system == 'darwin':
            for line in capture(['otool', '-L', binary]).splitlines()[1:]:
                assert line.strip().startswith(('/usr/lib/', '/System/Library/')), 'Unexpected non-system macOS library: ' + line
    package(target, binary)
    print(f'Built {release_version} for {target}', flush=True)


def assemble():
    release_version = version()
    records = []
    names = []
    for target in TARGETS:
        record = json.loads((OUT / f'TARGET-{target}.json').read_text())
        assert record['target'] == target and record['version'] == release_version
        assert record['commit'] == os.environ['GITHUB_SHA'], 'Mismatched source commit: ' + target
        assert record['native_smoke_test'] == record['sqlite_restart'] == 'passed'
        expected = {executable(target), f'fastpool-easymining-v{release_version}-{target}.zip'}
        assert set(record['files']) == expected, 'Wrong platform asset set'
        for name, sha in record['files'].items():
            assert digest(OUT / name) == sha, 'Checksum mismatch: ' + name
            names.append(name)
        check_header(OUT / executable(target), target)
        records.append(record)
    names.extend([f'fastpool-easymining-v{release_version}.zip', f'FastPool-EasyMining-GitHub-v{release_version}.zip'])
    for name in names:
        if name.endswith('.zip'):
            with zipfile.ZipFile(OUT / name) as zipped:
                assert zipped.testzip() is None, name
    info = {'version': release_version, 'commit': os.environ['GITHUB_SHA'], 'runtime': 'Go', 'platforms': records}
    (OUT / 'BUILD_INFO.json').write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
    names.append('BUILD_INFO.json')
    names.sort()
    (OUT / 'SHA256SUMS').write_text(''.join(digest(OUT / name) + '  ' + name + '\n' for name in names), encoding='utf-8')
    (OUT / 'RELEASE_ASSETS.txt').write_text('\n'.join(names + ['SHA256SUMS']) + '\n', encoding='utf-8')
    print('Verified all six native targets and assembled release checksums.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='command', required=True)
    for command in ['build', 'package']:
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument('--target', choices=TARGETS, required=True)
        if command == 'package':
            command_parser.add_argument('--binary', type=Path, required=True)
    subparsers.add_parser('assemble')
    arguments = parser.parse_args()
    os.chdir(ROOT)
    if arguments.command == 'build':
        build(arguments.target)
    elif arguments.command == 'package':
        package(arguments.target, arguments.binary)
    else:
        assemble()
