// Development/hosted preview packaging. The self-hosted app needs no Node runtime.
import {cpSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
mkdirSync('dist',{recursive:true});cpSync('public','dist',{recursive:true});
execFileSync('python3',['scripts/package-go.py'],{stdio:'inherit'});
console.log('Static paper preview built. The Go binary embeds public/ for self-hosting.');
