import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'liukaimin12-stack/duanran-work-releases';
const VERSIONS = new Set(['0.6.1']);
const MAX_INSTALLER = 200 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function requireOk(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, fields) {
  requireOk(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'Unexpected metadata fields.');
}
async function bounded(path, max) {
  const stat = await lstat(path);
  requireOk(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= max, 'Invalid bounded regular input.');
  const bytes = await readFile(path);
  requireOk(bytes.length === stat.size, 'Input changed while reading.'); return bytes;
}

export function verifyManifest(bytes) {
  requireOk(bytes.length > 0 && bytes.length <= 65536, 'Invalid manifest size.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  exactKeys(manifest, ['format','repository','release']);
  requireOk(manifest.format === 'duanran-github-test-release-1', 'Unsupported test manifest format.');
  exactKeys(manifest.repository, ['owner','repository','repositoryId']);
  requireOk(manifest.repository.owner === 'liukaimin12-stack' && manifest.repository.repository === 'duanran-work-releases' && manifest.repository.repositoryId === '1407176410', 'Unexpected release repository.');
  const p = manifest.release;
  exactKeys(p, ['appId','version','platform','file','sha256','size','dataSchema','readableDataSchemas','notes']);
  requireOk(p.appId === 'local.cc.desktop' && p.platform === 'win32-x64' && VERSIONS.has(p.version), 'Release identity/version outside this publication set.');
  requireOk(p.file === `DuanranWork-${p.version}-public-test-x64.exe`, 'Unexpected installer name.');
  requireOk(typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256) && Number.isSafeInteger(p.size) && p.size > 0 && p.size <= MAX_INSTALLER, 'Invalid installer digest/size.');
  requireOk(p.dataSchema === 2 && JSON.stringify(p.readableDataSchemas) === '[1,2]', 'Unexpected test data schema.');
  requireOk(typeof p.notes === 'string' && p.notes.length > 0 && p.notes.length <= 10000, 'Invalid public notes.');
  return p;
}

export async function assemble(root = process.cwd()) {
  const request = JSON.parse((await bounded(join(root,'transition-publish-request.json'),65536)).toString('utf8'));
  exactKeys(request, ['format','version','manifestSha256','chunks']);
  requireOk(request.format === 'duanran-transition-request-1' && VERSIONS.has(request.version) && typeof request.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.manifestSha256), 'Invalid publication request.');
  const directory = join(root,'packages',request.version);
  const manifest = await bounded(join(directory,'test-release.json'),65536);
  requireOk(sha256(manifest) === request.manifestSha256, 'Manifest digest mismatch.');
  const release = verifyManifest(manifest);
  requireOk(release.version === request.version, 'Requested version differs from manifest version.');
  requireOk(Array.isArray(request.chunks) && request.chunks.length > 0 && request.chunks.length <= 256, 'Invalid chunk count.');
  let declared = 0;
  request.chunks.forEach((chunk,index) => {
    exactKeys(chunk,['file','size','sha256']);
    requireOk(chunk.file === `part-${String(index).padStart(3,'0')}.bin` && Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= 4*1024*1024 && typeof chunk.sha256 === 'string' && /^[a-f0-9]{64}$/.test(chunk.sha256), 'Invalid or reordered chunk.');
    declared += chunk.size;
  });
  requireOk(declared === release.size, 'Chunk sizes differ from manifest installer size.');
  const output = join(root,'out'); await mkdir(output);
  const target = join(output,release.file); const temporary = `${target}.part`;
  const fd = await open(temporary,'wx',0o600); const digest = createHash('sha256'); let size = 0;
  try {
    for (const chunk of request.chunks) {
      const bytes = await bounded(join(directory,'chunks',chunk.file),4*1024*1024);
      requireOk(bytes.length === chunk.size && sha256(bytes) === chunk.sha256, 'Chunk integrity failed.');
      digest.update(bytes); size += bytes.length;
      await fd.writeFile(bytes);
    }
    requireOk(size === release.size && digest.digest('hex') === release.sha256, 'Whole installer integrity failed.');
    await fd.sync();
  } finally { await fd.close(); }
  await rename(temporary,target);
  const checksums = Buffer.from(`${release.sha256}  ${release.file}\n${sha256(manifest)}  test-release.json\n`);
  requireOk((await bounded(join(directory,'SHA256SUMS.txt'),4096)).equals(checksums), 'Checksums are not exactly the verified assets.');
  await writeFile(join(output,'test-release.json'),manifest,{flag:'wx'});
  await writeFile(join(output,'SHA256SUMS.txt'),checksums,{flag:'wx'});
  await writeFile(join(output,'notes.txt'),`${release.notes}\n\n<!-- duanran-manifest-sha256:${sha256(manifest)} -->\n`,{flag:'wx'});
  const assets = [
    {name:release.file,size:release.size,sha256:release.sha256},
    {name:'test-release.json',size:manifest.length,sha256:sha256(manifest)},
    {name:'SHA256SUMS.txt',size:checksums.length,sha256:sha256(checksums)},
  ];
  const receipt = {format:'duanran-verified-test-assets-1',repository:REPOSITORY,version:release.version,tag:`v${release.version}`,assets};
  await writeFile(join(output,'verified-assets.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assemble().then(r=>console.log(JSON.stringify(r,null,2))).catch(error=>{console.error(`Assembly rejected: ${error.message}`);process.exitCode=1;});
}
