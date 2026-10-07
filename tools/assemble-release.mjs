import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'liukaimin12-stack/duanran-work-releases';
export const PUBLISHER = Object.freeze({
  keyId: 'duanran-ed25519-4c57f913e6225d3912b13fdf',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASk6r4A2KGohgG1GTAkW15i4vsSbYOjNAsMFkAfC2S/s=\n-----END PUBLIC KEY-----\n',
});
const VERSIONS = new Set(['0.5.2', '0.5.3', '0.5.4', '0.5.5', '0.6.0']);
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

export function verifyEnvelope(bytes, publisher = PUBLISHER) {
  requireOk(bytes.length <= 65536, 'Manifest is too large.');
  const envelope = JSON.parse(bytes.toString('utf8'));
  exactKeys(envelope, ['keyId','payload','signature']);
  requireOk(envelope.keyId === publisher.keyId && typeof envelope.payload === 'string' && envelope.payload.length <= 20000 && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'Invalid signed envelope.');
  const key = createPublicKey(publisher.publicKeyPem);
  requireOk(key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature,'base64')), 'Publisher signature failed.');
  const p = JSON.parse(envelope.payload);
  exactKeys(p, ['appId','version','platform','file','sha256','size','dataSchema','readableDataSchemas','notes']);
  requireOk(p.appId === 'local.cc.desktop' && p.platform === 'win32-x64' && VERSIONS.has(p.version), 'Release identity/version outside this approved test release set.');
  requireOk(p.file === `DuanranWork-${p.version}-public-test-x64.exe`, 'Unexpected installer name.');
  requireOk(/^[a-f0-9]{64}$/.test(p.sha256) && Number.isSafeInteger(p.size) && p.size > 0 && p.size <= MAX_INSTALLER, 'Invalid installer digest/size.');
  requireOk(p.dataSchema === 2 && JSON.stringify(p.readableDataSchemas) === '[1,2]', 'Unexpected test data schema.');
  requireOk(typeof p.notes === 'string' && p.notes.length > 0 && p.notes.length <= 10000, 'Invalid public notes.');
  return p;
}

export async function assemble(root = process.cwd()) {
  const request = JSON.parse((await bounded(join(root,'publish-request.json'),65536)).toString('utf8'));
  exactKeys(request, ['format','version','manifestSha256','chunks']);
  requireOk(request.format === 'duanran-two-release-request-1' && VERSIONS.has(request.version) && /^[a-f0-9]{64}$/.test(request.manifestSha256), 'Invalid publication request.');
  const directory = join(root,'packages',request.version);
  const manifest = await bounded(join(directory,'release.json'),65536);
  requireOk(sha256(manifest) === request.manifestSha256, 'Manifest digest mismatch.');
  const release = verifyEnvelope(manifest); // Production key is fixed; no input-supplied key.
  requireOk(release.version === request.version, 'Requested version differs from signed version.');
  requireOk(Array.isArray(request.chunks) && request.chunks.length > 0 && request.chunks.length <= 256, 'Invalid chunk count.');
  let declared = 0;
  request.chunks.forEach((chunk,index) => {
    exactKeys(chunk,['file','size','sha256']);
    requireOk(chunk.file === `part-${String(index).padStart(3,'0')}.bin` && Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= 4*1024*1024 && /^[a-f0-9]{64}$/.test(chunk.sha256), 'Invalid or reordered chunk.');
    declared += chunk.size;
  });
  requireOk(declared === release.size, 'Chunk sizes differ from signed installer size.');
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
  const checksums = Buffer.from(`${release.sha256}  ${release.file}\n${sha256(manifest)}  release.json\n`);
  requireOk((await bounded(join(directory,'SHA256SUMS.txt'),4096)).equals(checksums), 'Checksums are not exactly the verified assets.');
  await writeFile(join(output,'release.json'),manifest,{flag:'wx'});
  await writeFile(join(output,'SHA256SUMS.txt'),checksums,{flag:'wx'});
  await writeFile(join(output,'notes.txt'),`${release.notes}\n\n<!-- duanran-manifest-sha256:${sha256(manifest)} -->\n`,{flag:'wx'});
  const assets = [
    {name:release.file,size:release.size,sha256:release.sha256},
    {name:'release.json',size:manifest.length,sha256:sha256(manifest)},
    {name:'SHA256SUMS.txt',size:checksums.length,sha256:sha256(checksums)},
  ];
  const receipt = {format:'duanran-verified-assets-1',repository:REPOSITORY,version:release.version,tag:`v${release.version}`,keyId:PUBLISHER.keyId,assets};
  await writeFile(join(output,'verified-assets.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assemble().then(r=>console.log(JSON.stringify(r,null,2))).catch(error=>{console.error(`Assembly rejected: ${error.message}`);process.exitCode=1;});
}

