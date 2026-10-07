import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPOSITORY, verifyManifest } from './assemble-transition.mjs';

function need(ok,message) { if (!ok) throw new Error(message); }
function gh(args, allow404=false) {
  const r=spawnSync('gh',args,{encoding:'utf8',maxBuffer:4*1024*1024,timeout:10*60*1000});
  if (r.status !== 0) {
    if (allow404 && /HTTP 404/.test(r.stderr ?? '')) return null;
    throw new Error('GitHub command failed; no credential or raw response is logged.');
  }
  return r.stdout;
}
function api(path, allow404=false) { const value=gh(['api',path,'--method','GET'],allow404); return value===null?null:JSON.parse(value); }
function findRelease(tag) {
  // The tag endpoint is documented for published releases. Authenticated listing
  // also includes drafts, so retries never blindly create a second draft.
  const releases=api(`repos/${REPOSITORY}/releases?per_page=100`);
  need(Array.isArray(releases) && releases.length<100,'Unexpectedly large release history; manual review required.');
  const matches=releases.filter(release=>release.tag_name===tag);
  need(matches.length<=1,'Ambiguous draft/release tag.');
  return matches[0] ?? null;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  need(process.env.GITHUB_ACTIONS === 'true' && process.env.GH_REPO === REPOSITORY && process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main', 'Publication is restricted to this repository main workflow.');
  need(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') && Boolean(process.env.GH_TOKEN), 'Missing managed workflow identity.');
  const repository=api(`repos/${REPOSITORY}`);
  need(repository.id===1407176410 && repository.full_name===REPOSITORY && repository.private===false,'Publication repository identity changed.');
  const manifest=await readFile('out/test-release.json'); const release=verifyManifest(manifest);
  const receipt=JSON.parse(await readFile('out/verified-assets.json','utf8'));
  need(receipt.format==='duanran-verified-test-assets-1' && receipt.repository===REPOSITORY && receipt.version===release.version && receipt.tag===`v${release.version}` && receipt.assets?.length===3, 'Verified receipt mismatch.');
  const names=[release.file,'test-release.json','SHA256SUMS.txt'];
  need(receipt.assets.every((asset,i)=>asset.name===names[i] && typeof asset.sha256==='string' && /^[a-f0-9]{64}$/.test(asset.sha256)), 'Unexpected asset list.');
  for(const asset of receipt.assets) {
    const bytes=await readFile(join('out',asset.name));
    need(bytes.length===asset.size && digest(bytes)===asset.sha256,'Verified asset changed before upload.');
  }
  need(receipt.assets[0].sha256===release.sha256 && receipt.assets[0].size===release.size && receipt.assets[1].sha256===digest(manifest), 'Assets differ from test manifest.');
  const marker=`<!-- duanran-manifest-sha256:${digest(manifest)} -->`;
  need(await readFile('out/notes.txt','utf8')===`${release.notes}\n\n${marker}\n`,'Public release notes differ from verified manifest notes.');
  const tag=receipt.tag;
  let existing=findRelease(tag);
  if (!existing) {
    gh(['release','create',tag,'--repo',REPOSITORY,'--draft','--target',process.env.GITHUB_SHA,'--title',`端然work ${tag}（公开测试）`,'--notes-file','out/notes.txt']);
    // GitHub release listing can lag behind a successful create response.
    // Poll only the read endpoint; never create a second draft on a missing read.
    const visibleBy=Date.now()+20_000;
    do {
      existing=findRelease(tag);
      if (existing) break;
      await new Promise(resolve=>setTimeout(resolve,1_000));
    } while (Date.now()<visibleBy);
  }
  need(existing && Number.isSafeInteger(existing.id) && existing.id>0 && existing.tag_name===tag && existing.prerelease===false,'Unexpected existing release identity.');
  need(typeof existing.body==='string' && existing.body.trimEnd().endsWith(marker),'Existing draft/release is bound to a different test manifest.');
  const route=`repos/${REPOSITORY}/releases/${existing.id}`;
  // Never move or replace a tag, published release, or asset with different bytes.
  const ref=api(`repos/${REPOSITORY}/git/ref/tags/${tag}`,true);
  need(/^[a-f0-9]{40}$/.test(existing.target_commitish ?? ''),'Existing release has no fixed commit anchor.');
  need(existing.draft===true || ref!==null,'Published release tag is missing.');
  if (ref) need(ref.object?.type==='commit' && ref.object?.sha===existing.target_commitish,'Existing tag differs from its original release anchor.');
  const matches=(asset,expected)=>asset.name===expected.name && asset.size===expected.size && asset.state==='uploaded' && asset.digest===`sha256:${expected.sha256}`;
  const emptyStarter=existing.assets.find(asset=>names.includes(asset.name) && asset.state==='starter' && asset.size===0);
  need(!emptyStarter,'A failed upload left an empty starter asset. Stop for explicit cleanup approval; this publisher never deletes or overwrites it.');
  need(existing.assets.every(asset=>receipt.assets.some(expected=>matches(asset,expected))),'Existing asset is unexpected or differs from approved bytes.');
  if (!existing.draft) {
    need(existing.assets.length===3 && receipt.assets.every(expected=>existing.assets.some(asset=>matches(asset,expected))),'Published release is incomplete or different.');
    console.log(JSON.stringify({alreadyPublished:true,version:release.version,url:existing.html_url},null,2)); return;
  }
  const anchor=existing.target_commitish;
  function refreshDraft() {
    const current=api(route);
    need(current.id===existing.id && current.tag_name===tag && current.target_commitish===anchor && current.prerelease===false,'Release identity changed during publication.');
    need(typeof current.body==='string' && current.body.trimEnd().endsWith(marker),'Release metadata changed during publication.');
    need(Array.isArray(current.assets) && current.assets.every(asset=>receipt.assets.some(expected=>matches(asset,expected))),'Release assets changed during publication.');
    const currentRef=api(`repos/${REPOSITORY}/git/ref/tags/${tag}`,true);
    need(current.draft===true || currentRef!==null,'Published release tag is missing.');
    if(currentRef) need(currentRef.object?.type==='commit' && currentRef.object?.sha===anchor,'Release tag changed during publication.');
    return current;
  }
  for(const expected of receipt.assets) {
    existing=refreshDraft();
    if(existing.assets.some(asset=>matches(asset,expected))) continue;
    need(existing.draft===true,'Published release cannot be modified.');
    gh(['release','upload',tag,join('out',expected.name),'--repo',REPOSITORY]); // No --clobber.
  }
  existing=refreshDraft();
  need(existing.assets.length===3 && receipt.assets.every(expected=>existing.assets.some(asset=>matches(asset,expected))),'Remote assets failed size/digest verification.');
  if(existing.draft) gh(['release','edit',tag,'--repo',REPOSITORY,'--draft=false','--latest']);
  const final=api(route); const latest=api(`repos/${REPOSITORY}/releases/latest`);
  const finalRef=api(`repos/${REPOSITORY}/git/ref/tags/${tag}`);
  need(finalRef?.object?.type==='commit' && finalRef.object.sha===anchor,'Final release tag identity failed.');
  need(final.id===existing.id && final.target_commitish===anchor && final.draft===false && final.prerelease===false && final.assets.length===3 && receipt.assets.every(expected=>final.assets.some(asset=>matches(asset,expected))) && latest.id===final.id && latest.tag_name===tag,'Release/latest verification failed.');
  console.log(JSON.stringify({published:true,version:release.version,url:final.html_url,assets:receipt.assets},null,2));
}
main().catch(error=>{console.error(`Publication stopped: ${error.message}`);process.exitCode=1;});

