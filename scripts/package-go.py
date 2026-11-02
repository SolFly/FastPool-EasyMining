#!/usr/bin/env python3
"""Package only the Go distribution. Node is a development tool, not a runtime."""
import hashlib,json,pathlib,re,zipfile
root=pathlib.Path(__file__).resolve().parents[1]
version=re.search(r'const Version = "([^"]+)"',(root/'internal/controller/value.go').read_text())[1]
files=[]
for name in ['README.md','CHANGELOG.md','API-AUDIT.md','LICENSE','docs','Dockerfile','compose.yaml','.env.example','.dockerignore','.gitignore','config.example.json','go.mod','go.sum','assets.go','cmd','internal','public','vendor','bin/fastpool-easymining-linux-amd64']:
 p=root/name
 files.extend([p] if p.is_file() else sorted(x for x in p.rglob('*') if x.is_file()))
files.extend([root/'scripts/package-go.py'])
archive_dir=root/'dist/downloads';archive_dir.mkdir(parents=True,exist_ok=True)
archive=archive_dir/f'fastpool-easymining-v{version}.zip'
prefix=f'FastPool-EasyMining-v{version}/'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for path in files:
  rel=path.relative_to(root).as_posix()
  assert not any(x in rel.split('/') for x in ['data','.git','.sites-runtime'])
  info=zipfile.ZipInfo(prefix+rel,date_time=(2026,11,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
  info.external_attr=(0o755 if rel.startswith('bin/') else 0o644)<<16
  z.writestr(info,path.read_bytes())
 checks=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(root).as_posix()+'\n' for p in files)
 z.writestr(prefix+'SHA256SUMS',checks)
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for path in files:assert z.read(prefix+path.relative_to(root).as_posix())==path.read_bytes()
print(json.dumps({'archive':str(archive),'files':len(files)+1,'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
