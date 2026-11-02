#!/usr/bin/env bash
# Builds from the checked-out source. Smoke tests use an isolated temporary ledger.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

version="$(python3 - <<'PY'
from pathlib import Path
import json, os, re
version = re.search(r'const Version = "([^"]+)"', Path('internal/controller/value.go').read_text())[1]
assert re.fullmatch(r'\d+\.\d+\.\d+-go', version), 'Invalid release version'
assert json.loads(Path('package.json').read_text())['version'] == version, 'package.json version mismatch'
ui = re.search(r"export const VERSION = '([^']+)'", Path('public/core.mjs').read_text())[1]
assert ui == version, 'Browser/server version mismatch'
ref = os.environ.get('GITHUB_REF', '')
if ref.startswith('refs/tags/'):
    assert ref == 'refs/tags/v' + version, 'Tag and application version differ'
assert Path('docs/releases/v' + version + '.md').is_file(), 'Missing release notes'
assert Path('LICENSE').is_file(), 'Missing application license'
print(version)
PY
)"

image="fastpool-easymining-ci:${GITHUB_SHA:-local}"
extract_container=''
smoke_container=''
cleanup() {
  if [ -n "$smoke_container" ]; then docker rm -f "$smoke_container" >/dev/null 2>&1 || true; fi
  if [ -n "$extract_container" ]; then docker rm -f "$extract_container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker build --tag "$image" .
extract_container="$(docker create "$image")"
mkdir -p bin dist/release
docker cp "$extract_container:/usr/local/bin/easymining" bin/fastpool-easymining-linux-amd64
chmod 755 bin/fastpool-easymining-linux-amd64
actual="$(bin/fastpool-easymining-linux-amd64 --version)"
test "$actual" = "FastPool EasyMining $version · Go"
file bin/fastpool-easymining-linux-amd64 | tee /dev/stderr | grep -q 'statically linked'

smoke_container="$(docker run --detach --network none \
  --tmpfs /data:uid=1000,gid=1000,mode=0700 \
  --env APP_PASSWORD=ci-synthetic-password-only \
  "$image")"
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$smoke_container" easymining --healthcheck; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs "$smoke_container"; exit 1; fi
docker exec "$smoke_container" wget -qO- http://127.0.0.1:8080/healthz \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["ok"] is True and r["runtime"]=="go" and r["version"]==sys.argv[1]; print(r)' "$version"
docker stop --time 10 "$smoke_container" >/dev/null

python3 scripts/package-go.py
node scripts/source-zip.mjs
cp bin/fastpool-easymining-linux-amd64 dist/release/
cp "dist/downloads/fastpool-easymining-v$version.zip" dist/release/
cp "dist/downloads/FastPool-EasyMining-GitHub-v$version.zip" dist/release/
cp "docs/releases/v$version.md" dist/release/RELEASE_NOTES.md

python3 - "$version" <<'PY'
from pathlib import Path
import hashlib, json, os, sys, zipfile
version = sys.argv[1]
out = Path('dist/release')
for path in out.glob('*.zip'):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, path.name
        names = archive.namelist()
        prefix = names[0].split('/')[0] + '/'
        assert prefix + 'LICENSE' in names, 'License missing from ' + path.name
        if 'GitHub' in path.name:
            assert prefix + '.github/workflows/ci.yml' in names
            assert prefix + '.github/workflows/release.yml' in names
        else:
            assert prefix + 'bin/fastpool-easymining-linux-amd64' in names
        for name in names:
            relative = name[len(prefix):]
            assert not any(part in {'.git', '.openai', '.sites-runtime', 'data', 'node_modules'} for part in Path(relative).parts), relative
            assert Path(relative).name not in {'.env', 'config.json', 'master.key', 'controller.sqlite'}, relative
info = {'version': version, 'commit': os.environ.get('GITHUB_SHA', ''),
        'target': 'linux/amd64', 'runtime': 'Go', 'build': 'Repository Dockerfile; static executable'}
(out / 'BUILD_INFO.json').write_text(json.dumps(info, indent=2) + '\n')
assets = ['fastpool-easymining-linux-amd64', 'fastpool-easymining-v' + version + '.zip',
          'FastPool-EasyMining-GitHub-v' + version + '.zip', 'BUILD_INFO.json']
(out / 'SHA256SUMS').write_text(''.join(hashlib.sha256((out / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in assets))
PY

if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'version=%s\n' "$version" >> "$GITHUB_OUTPUT"; fi
printf 'Built and verified FastPool EasyMining %s\n' "$version"
