import {mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync,crc32} from 'node:zlib';

// Small deterministic ZIP writer. Only these source trees enter the download;
// runtime data, repository metadata and hosted project identity are excluded.
export function sourceZip(root){
  const files=[],version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
  function walk(path){
    const file=join(root,path);
    if(statSync(file).isDirectory())for(const name of readdirSync(file).sort())walk(path+'/'+name);
    else files.push(path);
  }
  for(const name of ['README.md','CHANGELOG.md','API-AUDIT.md','docs','Dockerfile','compose.yaml','.env.example','.dockerignore','.gitignore','config.example.json','go.mod','go.sum','assets.go','cmd','internal','public','vendor','package.json','server','scripts','tests'])walk(name);
  const chunks=[],central=[];let offset=0;
  for(const path of files){
    const name=Buffer.from('FastPool-EasyMining-v'+version+'/'+path),data=readFileSync(join(root,path)),compressed=deflateRawSync(data),crc=crc32(data);
    const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(8,8);head.writeUInt16LE(33,12);
    head.writeUInt32LE(crc,14);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(name.length,26);
    chunks.push(head,name,compressed);
    const dir=Buffer.alloc(46);dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x800,8);dir.writeUInt16LE(8,10);dir.writeUInt16LE(33,14);
    dir.writeUInt32LE(crc,16);dir.writeUInt32LE(compressed.length,20);dir.writeUInt32LE(data.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);central.push(dir,name);
    offset+=head.length+name.length+compressed.length;
  }
  const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,centralBytes,end]);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
  const output=join(root,'dist','downloads',`FastPool-EasyMining-GitHub-v${version}.zip`);
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,sourceZip(root));
  console.log(output);
}
