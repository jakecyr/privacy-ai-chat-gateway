import {readFile,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const manifest=JSON.parse(await readFile('source-manifest.json'));
const paths=new Set(),tree=createHash('sha256');
for(const entry of manifest.files) {
  if(typeof entry.path!=='string'||entry.path.startsWith('/')||entry.path.split('/').some(part=>['','..','.'].includes(part))||paths.has(entry.path))throw new Error('invalid_manifest_path');
  paths.add(entry.path);
  if(!(await lstat(entry.path)).isFile())throw new Error('nonregular_source_file');
  const bytes=await readFile(entry.path),hash=createHash('sha256').update(bytes).digest('hex');
  if(hash!==entry.sha256||bytes.length!==entry.bytes)throw new Error('source_hash_mismatch: '+entry.path);
}
for(const path of [...paths].sort()) {
  const entry=manifest.files.find(file=>file.path===path);
  tree.update(Buffer.concat([Buffer.from(path+'\0'),Buffer.from(entry.sha256,'hex')]));
}
if(tree.digest('hex')!==manifest.sourceTreeSHA256)throw new Error('source_tree_mismatch');
if(!process.argv.includes('--files-only')) {
  const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
  if(resolve(root)!==process.cwd())throw new Error('standalone_backend_checkout_required');
  const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  paths.add('source-manifest.json');
  if(tracked.length!==paths.size||tracked.some(path=>!paths.has(path)))throw new Error('unmanifested_tracked_file');
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'});
  if(untracked)throw new Error('unexpected_untracked_source');
}
console.log(JSON.stringify({sourceTreeSHA256:manifest.sourceTreeSHA256,verifiedFiles:manifest.files.length}));
