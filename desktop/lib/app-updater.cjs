'use strict';
// Signed desktop updates; automatic checks fetch metadata only.
// This module never starts an installer,
// restores private data, quits Electron, or prepares the backend by itself.
// The root process supplies those capabilities as explicit callbacks.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = require('node:fs').createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
const protocol = require('./update-protocol.cjs');
const updateChain = require('./update-chain.cjs');
const runtimeLockModule = require('./runtime-lock.cjs');
const defaultTrust = require('./release-trust.json');

const REPOSITORY = protocol.REPOSITORY;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const RELEASE_BASE = protocol.RELEASE_BASE;
const MAX_MANIFEST = protocol.MAX_MANIFEST, MAX_STATE = 8192, MAX_INSTALLER = protocol.MAX_INSTALLER;
// a14 and the schema1 bridge keep the historical matrix. Newer apps read the
// bundled runtime-lock.json instead, so a core bump does not need a new updater.
const LEGACY_MATRIX = {astrbot:'4.29.3',python:'3.12',node:'22.23.4',ffmpeg:'9.0.2'};
const MINIMUM_OS = protocol.MINIMUM_OS;
const SUFFIXES = protocol.SUFFIXES;
const DEFAULT_LOCK = (()=>{try{return runtimeLockModule.load();}catch{return null;}})();
const MESSAGES = {
  SIGNATURE_INVALID:'更新清单签名无效，请从官方发布页重新检查。',
  MANIFEST_INVALID:'更新清单内容不符合要求，请等待官方修复。',
  MANIFEST_TOO_LARGE:'更新清单超过安全大小限制。',
  METADATA_TOO_LARGE:'发布信息超过安全大小限制。',
  NETWORK_FAILED:'无法获取官方更新，请检查网络后重试。',
  CHANNEL_INVALID:'请选择稳定版或 Alpha 更新通道。',
  DOWNGRADE_BLOCKED:'此版本低于当前版本或已验证版本，请使用明确的回退操作。',
  PLATFORM_UNSUPPORTED:'支持 Windows 10 22H2+/11 x64、macOS 13+ Apple Silicon、Ubuntu 22.04/24.04 x64。',
  FIRST_MANUAL_INSTALL:'旧版没有签名更新与回退支持，请先从官方发布页手动安装 0.3.0a3。',
  CHECK_REQUIRED:'请先检查官方更新。',
  DOWNLOAD_REQUIRED:'请先下载并校验当前版与目标版安装包。',
  INSTALLER_INVALID:'安装包缺失或校验失败，请重新下载。',
  BACKUP_FAILED:'私人数据备份未完成，更新已停止；请检查可用空间后重试。',
  STOP_FAILED:'服务未能安全停止，更新已停止，请关闭服务后重试。',
  INSTALLER_LAUNCH_FAILED:'安装程序未能打开，请继续安装或使用已保存的回退包。',
  CALLBACK_REQUIRED:'此安装方式尚未接入应用，请使用官方安装包。',
  STATE_INVALID:'更新记录损坏；请保留私人数据并使用官方安装包修复。',
  STORAGE_FAILED:'更新记录未能保存，请检查可用空间和目录权限。',
  UPDATER_BUSY:'另一项更新操作正在进行，请等待完成。',
  CANCELLED:'更新已取消；已验证的安装包和备份仍保留在本机。',
  ROLLBACK_UNAVAILABLE:'尚无可验证的上一版安装包和更新前备份。',
  DATA_RESTORE_REQUIRED:'此版本的数据发生变化，回退需要明确选择恢复更新前数据。',
  RESTORE_CONFIRMATION_REQUIRED:'恢复旧数据前需要明确确认；当前新数据将先另行备份。',
  RESTORE_FAILED:'旧数据恢复未完成；请保持服务停止并检查本机备份。',
  VERSION_NOT_APPLIED:'运行中的应用版本尚未完成替换，请完成系统安装并重新打开应用。',
  VERIFICATION_FAILED:'更新后的环境检查未通过，请继续修复环境或回退。',
  UPDATE_PENDING:'现有更新尚待安装或检查，请先继续、修复或回退。',
  RUNTIME_LOCK_INVALID:'内置运行版本锁定文件无效，已停止更新。',
  CONTINUATION_PAUSED:'上次更新衔接未完成，请点击继续更新重试。',
  TRANSITION_INVALID:'跨版本更新交接信息无效，已停止继续安装。',
  CHAIN_INVALID:'更新链记录损坏或已被取消，无法继续自动更新。',
};
class UpdateError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.STORAGE_FAILED); this.name='UpdateError'; this.code=Object.hasOwn(MESSAGES,code)?code:'STORAGE_FAILED'; }
}
const fail = code => {throw new UpdateError(code);};
const isObject = value => Boolean(value && typeof value==='object' && !Array.isArray(value));
const keysAre = (value, keys) => isObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function normalizeVersion(input) {
  const version=protocol.normalizeVersion(input);
  if(!version)fail('MANIFEST_INVALID');
  return version;
}
function compareVersions(left,right) {
  const value=protocol.compareVersions(left,right);
  if(value===null)fail('MANIFEST_INVALID');
  return value;
}
function protocolGuard(work) {
  try {return work();}
  catch(error) {
    if(error?.name==='ProtocolError')fail(Object.hasOwn(MESSAGES,error.code)?error.code:'MANIFEST_INVALID');
    throw error;
  }
}
function verifyManifest(raw,signature,{trust=defaultTrust,expectedVersion,runtime=LEGACY_MATRIX}={}) {
  if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);
  return protocolGuard(()=>protocol.verifyManifest(raw,signature,{trust,expectedVersion,runtime}));
}
function verifyModernManifest(raw,signature,{trust=defaultTrust,expectedTag,expectedVersion}={}) {
  if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);
  return protocolGuard(()=>protocol.verifyModern(raw,signature,{trust,expectedTag,expectedVersion}));
}
function validBackup(value) {
  return keysAre(value,value?.fingerprint===undefined?['id']:['id','fingerprint'])&&typeof value.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.id)&&!value.id.includes('..')&&(value.fingerprint===undefined||typeof value.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprint));
}
async function regularBytes(file,maxBytes) {
  const entry=await fs.lstat(file);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.size>maxBytes)fail('STATE_INVALID');
  const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>maxBytes)fail('STATE_INVALID');
    return await handle.readFile();
  }finally {await handle.close();}
}
async function verifyInstaller(file,asset) {
  let handle;
  try {
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size)fail('INSTALLER_INVALID');
    handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
    const opened=await handle.stat();
    if(!opened.isFile()||opened.size!==asset.size)fail('INSTALLER_INVALID');
    const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
    let total=0;
    for(;;) {
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      total+=bytesRead;if(total>asset.size)fail('INSTALLER_INVALID');
      digest.update(buffer.subarray(0,bytesRead));
    }
    if(total!==asset.size||digest.digest('hex')!==asset.sha256)fail('INSTALLER_INVALID');
  }catch {fail('INSTALLER_INVALID');}
  finally {await handle?.close();}
}
const PHASES=['idle','up-to-date','available','downloading','downloaded','snapshotting','install-ready','install-launched','awaiting-verification','installed','rolling-back','rollback-launched','awaiting-rollback-verification','rolled-back','repair-required'];
function validState(value) {
  const allowed=['format','phase','channel','highestVersion','targetVersion','previousVersion','backup','preRollbackBackup','rollbackRecord','errorCode','failedAction','direction'];
  if(!isObject(value)||Object.keys(value).some(key=>!allowed.includes(key))||value.format!==1||!PHASES.includes(value.phase)||!['alpha','stable'].includes(value.channel))return false;
  for(const key of ['highestVersion','targetVersion','previousVersion'])if(value[key]!==undefined){try{if(normalizeVersion(value[key])!==value[key])return false;}catch{return false;}}
  for(const key of ['backup','preRollbackBackup'])if(value[key]!==undefined&&!validBackup(value[key]))return false;
  if(value.rollbackRecord!==undefined) {
    const record=value.rollbackRecord;
    if(!keysAre(record,['targetVersion','previousVersion','backup'])||!validBackup(record.backup))return false;
    try {if(normalizeVersion(record.targetVersion)!==record.targetVersion||normalizeVersion(record.previousVersion)!==record.previousVersion||compareVersions(record.targetVersion,record.previousVersion)<=0)return false;}catch{return false;}
  }
  if(value.errorCode!==undefined&&!Object.hasOwn(MESSAGES,value.errorCode))return false;
  if(value.failedAction!==undefined&&!['check','download','install','rollback','verify'].includes(value.failedAction))return false;
  if(value.direction!==undefined&&!['update','rollback'].includes(value.direction))return false;
  return true;
}

class AppUpdater {
  constructor({runtime,currentVersion,platform=process.platform,arch=process.arch,osRelease=os.release(),distro={},fetch:request=globalThis.fetch,download,trust=defaultTrust,stopServices,snapshot,launchInstaller,restoreSnapshot,onProgress=()=>{},runtimeLock,transitionLock=null}) {
    this.directory=path.join(path.resolve(runtime),'app-updates');
    this.currentVersion=normalizeVersion(currentVersion);this.platform=platform;this.arch=arch;this.osRelease=osRelease;this.distro=distro;
    this.request=request;this.downloader=download;this.trust=trust;this.stopServices=stopServices;this.snapshot=snapshot;this.launchInstaller=launchInstaller;this.restoreSnapshot=restoreSnapshot;this.onProgress=onProgress;
    this.runtimeLock=runtimeLock||DEFAULT_LOCK;
    this.legacyMatrix={...(this.runtimeLock?.legacy||LEGACY_MATRIX)};
    this.matrix={...(this.runtimeLock?.runtime||LEGACY_MATRIX)};
    this.transitionLock=transitionLock||null;
    // The a14/bridge line discovers only the legacy signed namespace. The
    // 0.4+ app owns the new namespace so old clients can never see a schema2
    // manifest they cannot verify.
    this.namespace=(this.transitionLock||protocol.compareVersions(this.currentVersion,'0.4.0a0')<=0)?'legacy':'dwhale';
    this.state={format:1,phase:'idle',channel:protocol.channelFor(protocol.parseVersion(this.currentVersion))};
    this.loaded=false;this.corrupt=false;this.operation=null;this.controller=null;this.progress=null;this.progressNotifiedAt=0;this.operationId=null;
  }
  _platform() {
    const release=this.osRelease.split('.').map(Number);
    const supported=this.platform==='darwin'&&this.arch==='arm64'&&release[0]>=22||this.platform==='win32'&&this.arch==='x64'&&release[0]===10&&release[1]===0&&release[2]>=19045||this.platform==='linux'&&this.arch==='x64'&&this.distro.ID==='ubuntu'&&['22.04','24.04'].includes(this.distro.VERSION_ID);
    if(!supported)fail('PLATFORM_UNSUPPORTED');
    return `${this.platform}-${this.arch}`;
  }
  async _directory(...parts) {
    let directory=this.directory;
    for(const part of ['',...parts]) {
      if(part)directory=path.join(directory,part);
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const stat=await fs.lstat(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('STORAGE_FAILED');
    }
    return directory;
  }
  async _atomic(file,bytes) {
    const temporary=`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      try {if((await fs.lstat(file)).isSymbolicLink())fail('STORAGE_FAILED');}catch(error){if(error.code!=='ENOENT')throw error;}
      await fs.rename(temporary,file);
    }finally {await handle?.close();await fs.rm(temporary,{force:true});}
  }
  async _save() {await this._directory();await this._atomic(path.join(this.directory,'state.json'),Buffer.from(JSON.stringify(this.state)));}
  async _load() {
    if(this.loaded)return;
    this.loaded=true;
    try {
      // No directory creation or network request is needed for an idle status.
      const stat=await fs.lstat(this.directory);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('STATE_INVALID');
      const value=JSON.parse((await regularBytes(path.join(this.directory,'state.json'),MAX_STATE)).toString('utf8'));
      if(!validState(value))fail('STATE_INVALID');
      this.state=value;
      if(!value.rollbackRecord&&value.backup&&value.previousVersion&&value.targetVersion)value.rollbackRecord={targetVersion:value.targetVersion,previousVersion:value.previousVersion,backup:{...value.backup}};
      if(value.phase==='install-launched'&&value.targetVersion===this.currentVersion)this.state.phase='awaiting-verification';
      if(value.phase==='rollback-launched'&&value.previousVersion===this.currentVersion)this.state.phase='awaiting-rollback-verification';
      await this._retireLegacyCompletedState();
    }catch(error) {
      if(error.code==='ENOENT')return;
      this.corrupt=true;this.state={format:1,phase:'repair-required',channel:this.state.channel,errorCode:'STATE_INVALID'};
    }
  }
  async _retireLegacyCompletedState() {
    // A manual installation can supersede a completed update from the memorial
    // repository. Its signed cache is used only to recognize that history and
    // is never accepted for a new download, installation, or rollback.
    const state = this.state;
    if (!['idle', 'up-to-date', 'installed', 'rolled-back'].includes(state.phase)
      || state.errorCode || !state.targetVersion) return;
    if (compareVersions(this.currentVersion, '0.4.0a2') < 0
      || compareVersions(state.targetVersion, '0.4.0a2') >= 0
      || compareVersions(state.targetVersion, this.currentVersion) >= 0) return;
    let historical;
    try {
      const directory = path.join(this.directory, 'manifests', state.targetVersion);
      for (const folder of [path.join(this.directory, 'manifests'), directory]) {
        const stat = await fs.lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      }
      const raw = await regularBytes(path.join(directory, 'release-manifest.json'), MAX_MANIFEST);
      const signature = await regularBytes(path.join(directory, 'release-manifest.sig'), 64);
      if (typeof this.trust.legacyPublicKey !== 'string') return;
      protocol.verifySignature(raw, signature, { ...this.trust, publicKey: this.trust.legacyPublicKey });
      historical = JSON.parse(raw.toString('utf8'));
    } catch { return; }
    if (!isObject(historical) || historical.repository !== 'XianZe1226/DSWhale'
      || historical.version !== state.targetVersion) return;
    const historicalProduct = historical.schemaVersion === 1 && historical.product === 'DSWhale'
      || historical.schemaVersion === 2 && historical.product === 'DWhale' && historical.productId === protocol.PRODUCT_ID;
    if (!historicalProduct) return;
    // Keep the complete old recovery record and all related media/backups. Only
    // the active intent is reset after its archive has been durably written.
    const archive = path.join(this.directory, `retired-legacy-state-${crypto.randomBytes(16).toString('hex')}.json`);
    await this._atomic(archive, Buffer.from(JSON.stringify(state)));
    this.state = { format: 1, phase: 'idle', channel: state.channel };
    await this._save();
  }
  _abort() {if(this.controller?.signal.aborted)fail('CANCELLED');}
  _progress(phase, details = {}) {
    const labels={preparing:'正在准备更新',downloading:'正在下载 DWhale 更新',restarting:'服务器未继续断点下载，正在重新下载当前文件',verifying:'正在校验安装包',downloaded:'安装包已就绪',snapshotting:'正在备份配置与记忆','install-ready':'正在完成环境升级','install-launched':'正在打开覆盖安装程序'};
    if(!Object.hasOwn(labels,phase)){this.progress=null;return;}
    const prior=this.progress;
    const total=Number.isSafeInteger(details.transferTotalBytes)&&details.transferTotalBytes>0?details.transferTotalBytes:Number.isSafeInteger(details.totalBytes)&&details.totalBytes>0?details.totalBytes:0;
    const transferred=Number.isSafeInteger(details.transferredBytes)&&details.transferredBytes>=0?Math.min(total||Infinity,details.transferredBytes):Number.isSafeInteger(details.receivedBytes)&&details.receivedBytes>=0?Math.min(total||Infinity,details.receivedBytes):0;
    const cached=Number.isSafeInteger(details.cachedBytes)&&details.cachedBytes>0?details.cachedBytes:0;
    const ratio=details.ratio===null?null:Number.isFinite(details.ratio)?Math.max(0,Math.min(1,details.ratio)):phase==='downloaded'?(total>0?1:null):total>0?Math.max(0,Math.min(1,transferred/total)):null;
    this.progress={
      operationId:details.operationId??this.operationId,targetVersion:details.targetVersion||this.state.targetVersion||null,phase,stage:phase,
      label:labels[phase]||'正在处理更新',transferredBytes:transferred,transferTotalBytes:total,cachedBytes:cached,ratio,
      receivedBytes:transferred,totalBytes:total,updatedAt:Date.now(),
    };
    const forced=phase!=='downloading'||ratio===0||ratio===1||!prior||prior.phase!==phase||prior.transferTotalBytes!==total;
    if(!forced&&Date.now()-this.progressNotifiedAt<100)return;
    this.progressNotifiedAt=Date.now();
    try{this.onProgress({phase,step:this.progress.label,progress:{...this.progress}});}catch{}
  }
  _run(action,work,{quiet=false}={}) {
    if(this.operation)return Promise.reject(new UpdateError('UPDATER_BUSY'));
    this.controller=new AbortController();
    this.operationId=crypto.randomBytes(8).toString('hex');
    this.operation=(async()=>{
      await this._load();if(this.corrupt&&!quiet)fail('STATE_INVALID');
      const before=quiet?structuredClone(this.state):null;
      try {
        if(!quiet&&['download','install'].includes(action))this._progress('preparing');
        const result=await work();return result;
      }catch(error) {
        const code=this.controller.signal.aborted?'CANCELLED':error instanceof UpdateError?error.code:'STORAGE_FAILED';
        if(quiet)this.state=before;
        else {this.progress=null;this.state.errorCode=code;this.state.failedAction=action;
          try{await this._save();}catch{}
        }
        throw new UpdateError(code);
      }
    })().finally(()=>{this.operation=null;this.controller=null;this.operationId=null;});
    return this.operation;
  }
  async _checkpoint(phase,{notify=true}={}) {this._abort();this.state.phase=phase;delete this.state.errorCode;delete this.state.failedAction;await this._save();if(notify)this._progress(phase);}
  async _metadata(url,maxBytes) {
    const signal=this.controller?.signal;
    const timeout=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try {
      const response=await this.request(url,{signal:combined,redirect:'follow',credentials:'omit',headers:{'User-Agent':'DSWhale-Desktop','Accept':new URL(url).hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'}});
      if(!response.ok||!response.body)fail('NETWORK_FAILED');
      if(response.url) {
        const final=new URL(response.url);
        if(final.protocol!=='https:'||final.username||final.password||final.port||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(final.hostname))fail('NETWORK_FAILED');
      }
      if(Number(response.headers.get('content-length'))>maxBytes)fail(maxBytes===MAX_MANIFEST?'MANIFEST_TOO_LARGE':'METADATA_TOO_LARGE');
      const chunks=[];let count=0;
      for await(const chunk of response.body) {
        combined.throwIfAborted();count+=chunk.length;
        if(count>maxBytes)fail(maxBytes===MAX_MANIFEST?'MANIFEST_TOO_LARGE':'METADATA_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }catch(error){if(error instanceof UpdateError)throw error;if(signal?.aborted)fail('CANCELLED');fail('NETWORK_FAILED');}
  }
  _currentSource() {
    const normalized = normalizeVersion(this.currentVersion);
    const bridge = this.transitionLock?.bridge?.version ? normalizeVersion(this.transitionLock.bridge.version) : null;
    if (bridge && normalized === bridge) return { namespace: 'legacy', tag: `v${this.currentVersion}` };
    if (normalized && compareVersions(normalized, '0.4.0a0') > 0) {
      const parsed = protocol.parseVersion(normalized);
      return { namespace: 'dwhale', tag: `dwhale-v${parsed.npmVersion}` };
    }
    return { namespace: 'legacy', tag: `v${this.currentVersion}` };
  }
  async _currentManifest() {
    const cached = await this._cachedManifest(this.currentVersion).catch(() => null);
    if (cached) return cached;
    const source = this._currentSource();
    return this._fetchManifest(this.currentVersion, { namespace: source.namespace, tag: source.tag });
  }
  async _fetchManifest(version,{namespace='legacy',tag=null}={}) {
    version=normalizeVersion(version);
    const modern=namespace==='dwhale';
    const prefix=modern?tag:`v${version}`;
    if(!prefix)fail('MANIFEST_INVALID');
    const url=`${RELEASE_BASE}${prefix}/release-manifest`;
    const raw=await this._metadata(`${url}.json`,MAX_MANIFEST);
    const signature=await this._metadata(`${url}.sig`,64);
    const manifest=modern
      ?verifyModernManifest(raw,signature,{trust:this.trust,expectedTag:prefix,expectedVersion:version})
      :verifyManifest(raw,signature,{trust:this.trust,expectedVersion:version,runtime:this.legacyMatrix});
    Object.defineProperty(manifest,'rawSha256',{value:protocol.sha256(raw),enumerable:false});
    const directory=await this._directory('manifests',version);
    await this._atomic(path.join(directory,'release-manifest.json'),raw);
    await this._atomic(path.join(directory,'release-manifest.sig'),signature);
    return manifest;
  }
  async _cachedManifest(version) {
    try {
      normalizeVersion(version);
      for(const directory of [this.directory,path.join(this.directory,'manifests'),path.join(this.directory,'manifests',version)]) {
        const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('MANIFEST_INVALID');
      }
      const directory=path.join(this.directory,'manifests',version);
      const raw=await regularBytes(path.join(directory,'release-manifest.json'),MAX_MANIFEST);
      const signature=await regularBytes(path.join(directory,'release-manifest.sig'),64);
      const manifest=protocol.manifestKind(raw)===2?verifyModernManifest(raw,signature,{trust:this.trust,expectedVersion:version}):verifyManifest(raw,signature,{trust:this.trust,expectedVersion:version,runtime:this.legacyMatrix});
      Object.defineProperty(manifest,'rawSha256',{value:protocol.sha256(raw),enumerable:false});
      return manifest;
    }catch(error){if(error instanceof UpdateError)throw error;fail('MANIFEST_INVALID');}
  }
  _installerPath(manifest) {return path.join(this.directory,'installers',manifest.version,manifest.assets[`${this.platform}-${this.arch}`].name);}
  async _installerPresent(manifest) {
    if(!manifest?.assets[`${this.platform}-${this.arch}`])return false;
    try {
      for(const directory of [this.directory,path.join(this.directory,'installers'),path.join(this.directory,'installers',manifest.version)]) {
        const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())return false;
      }
      const stat=await fs.lstat(this._installerPath(manifest));
      return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===manifest.assets[`${this.platform}-${this.arch}`].size;
    }catch{return false;}
  }
  async _verifyInstaller(manifest) {
    this._progress('verifying');
    if(!await this._installerPresent(manifest))fail('INSTALLER_INVALID');
    await verifyInstaller(this._installerPath(manifest),manifest.assets[`${this.platform}-${this.arch}`]);
  }
  async _downloadInstaller(manifest,{target=false}={}) {
    const platform=this._platform(),asset=manifest.assets[platform];
    await this._directory('installers',manifest.version);
    const file=this._installerPath(manifest);
    let cachedPrefix=0;
    try{const stat=await fs.lstat(`${file}.part`);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=asset.size)cachedPrefix=stat.size;}catch{}
    const report=(transferred,extra={})=>this._progress('downloading',{targetVersion:manifest.version,transferredBytes:transferred,transferTotalBytes:Math.max(1,asset.size-cachedPrefix),cachedBytes:cachedPrefix,...extra});
    try {await this._verifyInstaller(manifest);if(target)this._progress('downloaded',{targetVersion:manifest.version,transferredBytes:0,transferTotalBytes:0,cachedBytes:asset.size,ratio:null});return {cached:true};}catch{}
    if(!target)this._progress('preparing',{targetVersion:this.state.targetVersion});
    else report(0,{ratio:0});
    // Remove a bad regular file, never write through a symlink.
    try {if((await fs.lstat(file)).isSymbolicLink())fail('INSTALLER_INVALID');await fs.rm(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    const download=this.downloader||require('./runtime.cjs').downloadVerified;
    let measuredTransferred=0, measuredCached=0;
    try {await download(asset,file,{fetch:this.request,maxBytes:asset.size,signal:this.controller.signal,onProgress:(ratio,measurement)=>{
      if(!target)return;
      if(measurement?.restarting){this._progress('restarting',{targetVersion:manifest.version,transferredBytes:0,transferTotalBytes:asset.size,cachedBytes:Number.isSafeInteger(measurement.cachedBytes)?measurement.cachedBytes:0,ratio:0});return;}
      const transferred=Number.isSafeInteger(measurement?.transferredBytes)?measurement.transferredBytes:Number.isFinite(ratio)?Math.floor(asset.size*ratio):0;
      const cached=Number.isSafeInteger(measurement?.cachedBytes)&&measurement.cachedBytes>0?measurement.cachedBytes:0;
      measuredTransferred=Math.max(0,Math.min(asset.size,transferred));measuredCached=cached;
      const remaining=Math.max(1,asset.size-cached);
      report(measuredTransferred,{cachedBytes:cached,transferTotalBytes:remaining});
    }});}
    catch(error){if(error instanceof UpdateError)throw error;if(this.controller.signal.aborted)fail('CANCELLED');fail('NETWORK_FAILED');}
    await this._verifyInstaller(manifest);
    if(target){
      if(measuredTransferred===0&&measuredCached===0&&cachedPrefix>0)measuredCached=cachedPrefix;
      const remaining=Math.max(1,asset.size-measuredCached);
      this._progress('downloaded',{targetVersion:manifest.version,transferredBytes:Math.min(remaining,measuredTransferred),transferTotalBytes:remaining,cachedBytes:measuredCached,ratio:1});
    }
    return {cached:false};
  }
  async status() {
    await this._load();
    let target,previous,metadataError,rollbackTarget,rollbackPrevious,rollbackError;
    try{if(this.state.targetVersion)target=await this._cachedManifest(this.state.targetVersion);if(this.state.previousVersion)previous=await this._cachedManifest(this.state.previousVersion);}catch(error){metadataError=error instanceof UpdateError?error.code:'MANIFEST_INVALID';}
    const rollback=this.state.rollbackRecord;
    try{if(rollback){rollbackTarget=await this._cachedManifest(rollback.targetVersion);rollbackPrevious=await this._cachedManifest(rollback.previousVersion);}}catch(error){rollbackError=error instanceof UpdateError?error.code:'MANIFEST_INVALID';}
    const targetPresent=await this._installerPresent(target),previousPresent=await this._installerPresent(previous);
    const canDownload=!this.corrupt&&!metadataError&&Boolean(target)&&compareVersions(target.version,this.currentVersion)>0&&['available','downloading','downloaded','up-to-date'].includes(this.state.phase);
    const canInstall=!this.corrupt&&!metadataError&&targetPresent&&previousPresent&&compareVersions(target.version,this.currentVersion)>0&&previous.version===this.currentVersion&&['downloaded','snapshotting','install-ready','install-launched'].includes(this.state.phase);
    let chain=null,chainOriginPresent=false;
    if(this.transitionLock){try{chain=await this._chainState();}catch{}}
    if(chain?.originInstaller){try{const {asset}=await this._originManifest(chain);const stat=await fs.lstat(path.join(this.directory,'installers',chain.originVersion,asset.name));chainOriginPresent=stat.isFile()&&!stat.isSymbolicLink()&&stat.size===asset.size;}catch{}}
    const canRollback=!this.corrupt&&!rollbackError&&(
      (Boolean(rollback)&&Boolean(rollbackTarget)&&await this._installerPresent(rollbackPrevious)&&[rollback.targetVersion,rollback.previousVersion].includes(this.currentVersion)&&this.state.phase!=='rolled-back')
      ||(Boolean(chain)&&chainOriginPresent&&['install-launched','completed','repair-required'].includes(chain.terminalState)&&[chain.fixedFinalTarget.version,chain.bridge.version].includes(this.currentVersion)&&this.state.phase!=='rolled-back')
    );
    const code=metadataError||rollbackError||this.state.errorCode;
    const interrupted=Boolean(code)||['downloading','snapshotting','install-ready','install-launched','rolling-back','rollback-launched'].includes(this.state.phase);
    const actions=['check',...(canDownload?['download']:[]),...(canInstall?['install']:[]),...(canRollback?['rollback']:[]),...(['awaiting-verification','awaiting-rollback-verification'].includes(this.state.phase)?['verify']:[]),...(this.state.phase==='repair-required'?['repair']:[])];
    return {progress:this.progress?{...this.progress}:null,currentVersion:this.currentVersion,targetVersion:this.state.targetVersion||null,previousVersion:rollback?.previousVersion||this.state.previousVersion||null,channel:this.state.channel,phase:this.corrupt?'repair-required':this.state.phase,canDownload,canInstall,canRollback,actions,
      impact:target?{...target.impact}:null,matrix:target?{...target.runtime}:{...this.matrix},minimumOS:{...MINIMUM_OS,linux:[...MINIMUM_OS.linux]},
      error:code?{code,message:MESSAGES[code]||MESSAGES.STORAGE_FAILED}:null,
      recovery:{interrupted,continueAction:canInstall?'install':canDownload?'download':null,requiresHealthVerification:['awaiting-verification','awaiting-rollback-verification','repair-required'].includes(this.state.phase),servicesMustRemainStopped:['snapshotting','install-ready','install-launched','awaiting-verification','rolling-back','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase),rollbackRequiresDataRestore:Boolean(rollbackTarget&&(rollbackTarget.impact.dataMigration||!rollbackTarget.impact.rollbackCompatible)),guidance:code?MESSAGES[code]:this.state.phase==='install-launched'?'请完成系统安装并重新打开应用；保留的旧版安装包和备份可用于回退。':this.state.phase==='rollback-launched'?'请完成旧版系统安装，重新打开应用后检查环境。':interrupted?'操作尚未完成，可继续下载或安装；备份保留在本机。':'更新仅在你明确操作时进行。'}};
  }
  _automaticCheckAllowed() {
    if(this.corrupt||this.state.errorCode||!['idle','up-to-date','available','installed','rolled-back'].includes(this.state.phase))return false;
    if(this.state.phase!=='available'&&this.state.targetVersion&&compareVersions(this.state.targetVersion,this.currentVersion)>0)return false;
    try{this._platform();return true;}catch{return false;}
  }
  check({channel,automatic=false}={}) {
    return this._run('check',async()=>{
      if(automatic&&!this._automaticCheckAllowed())return null;
      channel=channel===undefined?this.state.channel:channel;
      this._platform();if(!['alpha','stable'].includes(channel))fail('CHANNEL_INVALID');
      if(this.runtimeLock&&!this.runtimeLock.runtime)fail('RUNTIME_LOCK_INVALID');
      if(['snapshotting','install-ready','install-launched','awaiting-verification','rolling-back','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase))fail('UPDATE_PENDING');
      let releases;try{releases=JSON.parse((await this._metadata(RELEASE_API,1024*1024)).toString('utf8'));}catch(error){if(error instanceof UpdateError)throw error;fail('MANIFEST_INVALID');}
      if(!Array.isArray(releases)||releases.length>100)fail('MANIFEST_INVALID');
      const candidates=[];
      for(const release of releases) {
        if(!isObject(release)||release.draft!==false||typeof release.tag_name!=='string')continue;
        const parsed=protocol.parseTag(release.tag_name);
        if(!parsed||parsed.namespace!==this.namespace)continue;
        // A signed manifest may only use its own tag namespace; the release
        // flag must agree and the stable channel must never pick a prerelease.
        if(release.prerelease!==parsed.preRelease)continue;
        if(channel==='stable'&&parsed.preRelease)continue;
        candidates.push(parsed);
      }
      this._abort();candidates.sort((a,b)=>protocol.compareVersions(b.version,a.version));this.state.channel=channel;
      // Metadata-only discoveries can advance, but an empty/replayed release
      // list must never dismiss the already authenticated available target.
      if(automatic&&this.state.phase==='available'&&!candidates.length)return this.status();
      if(!candidates.length){if(!this.state.backup)await this._checkpoint('up-to-date',{notify:!automatic});else await this._save();return this.status();}
      const found=candidates[0],version=found.version;
      if(compareVersions(version,this.currentVersion)<0||this.state.highestVersion&&compareVersions(version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      // Retain the authenticated pair for an unchanged available target;
      // replacing its JSON and signature independently could break that cache.
      if(automatic&&this.state.phase==='available'&&version===this.state.targetVersion)return this.status();
      if(version===this.currentVersion){if(!this.state.backup)await this._checkpoint('up-to-date',{notify:!automatic});else await this._save();return this.status();}
      await this._fetchManifest(version,{namespace:found.namespace,tag:found.tag});this._abort();
      this.state={...this.state,format:1,phase:'available',channel,highestVersion:version,targetVersion:version};
      await this._checkpoint('available',{notify:!automatic});return this.status();
    },{quiet:automatic});
  }
  async _chainState() {
    try {
      const chain = updateChain.parse(await regularBytes(path.join(this.directory,'transition-lock.json'),MAX_MANIFEST));
      if (this.transitionLock) {
        const packaged = updateChain.validate(this.transitionLock);
        if (chain.chainId !== packaged.chainId || JSON.stringify(chain.fixedFinalTarget) !== JSON.stringify(packaged.fixedFinalTarget)) return null;
      }
      return chain;
    } catch {return null;}
  }
  async _originManifest(chain) {
    const manifest = await this._cachedManifest(chain.originVersion);
    const asset = manifest.assets[`${this.platform}-${this.arch}`];
    if (!asset) fail('ROLLBACK_UNAVAILABLE');
    return { manifest, asset };
  }
  async _verifyOriginInstaller(chain) {
    const { manifest, asset } = await this._originManifest(chain);
    if (chain.originInstaller && (
      chain.originInstaller.name !== asset.name
      || chain.originInstaller.size !== asset.size
      || chain.originInstaller.sha256 !== asset.sha256
    )) fail('INSTALLER_INVALID');
    const file = path.join(this.directory, 'installers', chain.originVersion, asset.name);
    await verifyInstaller(file, asset);
    return { manifest, asset, file };
  }
  async _findOriginInstaller(chain) {
    try {
      const { asset } = await this._originManifest(chain);
      await verifyInstaller(path.join(this.directory, 'installers', chain.originVersion, asset.name), asset);
      return { name: asset.name, size: asset.size, sha256: asset.sha256 };
    } catch { return null; }
  }
  _originFilePath(chain) {
    return path.join(this.directory, 'installers', chain.originVersion, chain.originInstaller.name);
  }
  async _enrichChain(chain) {
    let next = { ...chain };
    if (next.originBackup === null) {
      const backup = this.state.rollbackRecord?.backup?.id || this.state.backup?.id;
      if (backup) next.originBackup = backup;
    }
    if (next.originInstaller === null) {
      const installer = await this._findOriginInstaller(next);
      if (installer) next.originInstaller = installer;
    } else {
      const { asset } = await this._originManifest(next);
      if (next.originInstaller.name !== asset.name || next.originInstaller.size !== asset.size || next.originInstaller.sha256 !== asset.sha256) fail('INSTALLER_INVALID');
    }
    if (next.originBackup !== chain.originBackup || next.originInstaller !== chain.originInstaller) {
      next = updateChain.validate(next);
      await this._writeChain(next);
    }
    return next;
  }
  async _writeChain(value) {
    await this._directory();
    await this._atomic(path.join(this.directory,'transition-lock.json'),Buffer.from(JSON.stringify(value)));
  }
  async _continuationFailure(chain) {
    try {
      const value=JSON.parse((await regularBytes(path.join(this.directory,'continuation-failure.json'),1024)).toString('utf8'));
      return value?.chainId===chain.chainId?value:null;
    } catch {return null;}
  }
  async _markContinuationFailure(chain,error) {
    try {
      await this._directory();
      await this._atomic(path.join(this.directory,'continuation-failure.json'),Buffer.from(JSON.stringify({chainId:chain.chainId,code:error?.code||'TRANSITION_INVALID',at:new Date().toISOString()})));
    } catch {}
  }
  async _clearContinuationFailure() {
    try {await fs.rm(path.join(this.directory,'continuation-failure.json'),{force:true});} catch {}
  }
  continueTransition({automatic=false}={}) {
    return this._run('install',async()=>{
      if(!this.transitionLock)fail('TRANSITION_INVALID');
      let chain=await this._chainState();
      if(!chain){try {chain=updateChain.validate(this.transitionLock);}catch {fail('TRANSITION_INVALID');}}
      if(!automatic) await this._clearContinuationFailure();
      else if(await this._continuationFailure(chain))fail('CONTINUATION_PAUSED');
      try {
        const resumable=['awaiting-verification','downloading','downloaded','install-ready'];
        if(!resumable.includes(this.state.phase)||this.state.direction==='rollback')fail('TRANSITION_INVALID');
        if(chain.terminalState!=='pending')fail('TRANSITION_INVALID');
        chain=await this._enrichChain(chain);
        if(!chain.originBackup||!chain.originInstaller)fail('TRANSITION_INVALID');
        if(normalizeVersion(this.state.previousVersion)!==normalizeVersion(chain.originVersion))fail('TRANSITION_INVALID');
        let fixed;
        try {fixed=updateChain.nextTarget(chain,this.currentVersion);}catch {fail('TRANSITION_INVALID');}
        if(!fixed)fail('TRANSITION_INVALID');
        const packaged=updateChain.validate(this.transitionLock);
        if(JSON.stringify(fixed)!==JSON.stringify(packaged.fixedFinalTarget))fail('TRANSITION_INVALID');
        const manifest=await this._fetchManifest(fixed.version,{namespace:'dwhale',tag:fixed.tag});
        if(manifest.rawSha256!==fixed.manifestSha256||manifest.commit!==fixed.commit||manifest.runtimeLockSha256!==fixed.runtimeLockSha256)fail('TRANSITION_INVALID');
        for(const [platform,asset] of Object.entries(manifest.assets)) {
          const expected=fixed.assets[platform];
          if(!expected||asset.name!==expected.name||asset.size!==expected.size||asset.sha256!==expected.sha256)fail('TRANSITION_INVALID');
        }
        this._platform();
        // Persist the fixed target before touching the network so a crash in
        // the transfer can be resumed instead of looking like a bridge install.
        this.state.targetVersion=manifest.version;
        this.state.previousVersion=chain.originVersion;
        await this._save();
        await this._checkpoint('downloading',{notify:false});
        await this._downloadInstaller(manifest,{target:true});
        this.state.targetVersion=manifest.version;this.state.previousVersion=chain.originVersion;await this._save();
        await this._verifyInstaller(manifest);
        await this._stop();await this._checkpoint('snapshotting');
        this.state.backup=await this._snapshot('bridge-continuation');await this._save();
        // The chain origin stays the rollback endpoint; the bridge snapshot is
        // retained separately and never replaces the original backup.
        this.state.rollbackRecord={targetVersion:manifest.version,previousVersion:chain.originVersion,backup:{id:chain.originBackup}};
        this.state.direction='update';
        try {await this._writeChain(updateChain.advance(chain,'install-launched',manifest.version));}catch {fail('TRANSITION_INVALID');}
        await this._checkpoint('install-ready');
        await this._launch(manifest,false);
        await this._clearContinuationFailure();
        return this.status();
      } catch (error) {
        // A failed automatic continuation must not retry in a loop on every
        // restart; the user can explicitly resume with a fresh intent.
        await this._markContinuationFailure(chain,error);
        throw error;
      }
    });
  }
  download() {
    return this._run('download',async()=>{
      this._platform();if(compareVersions(this.currentVersion,'0.3.0a3')<0)fail('FIRST_MANUAL_INSTALL');
      if(!this.state.targetVersion)fail('CHECK_REQUIRED');
      if(['install-launched','awaiting-verification','installed','rollback-launched','awaiting-rollback-verification','repair-required'].includes(this.state.phase))fail('UPDATE_PENDING');
      const target=await this._cachedManifest(this.state.targetVersion);
      if(compareVersions(target.version,this.currentVersion)<=0||this.state.highestVersion&&compareVersions(target.version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      await this._checkpoint('downloading',{notify:false});
      // The rollback installer for the running app is prepared first but is
      // explicitly excluded from the target download progress. A cached copy
      // from an earlier attempt also contributes zero transferred bytes.
      const previous=await this._currentManifest();
      await this._downloadInstaller(previous,{target:false});this.state.previousVersion=previous.version;await this._save();
      await this._downloadInstaller(target,{target:true});
      await this._checkpoint('downloaded',{notify:false});
      return this.status();
    });
  }
  async _stop() {
    if(typeof this.stopServices!=='function')fail('CALLBACK_REQUIRED');
    try {const stopped=await this.stopServices({signal:this.controller.signal});if(stopped===false)fail('STOP_FAILED');}
    catch {fail('STOP_FAILED');}
    this._abort();
  }
  async _snapshot(reason) {
    if(typeof this.snapshot!=='function')fail('CALLBACK_REQUIRED');
    let backup;
    try{const value=await this.snapshot({reason,signal:this.controller.signal});backup={id:value?.id,...(value?.fingerprint!==undefined?{fingerprint:value.fingerprint}:{})};if(!validBackup(backup))fail('BACKUP_FAILED');}
    catch {fail('BACKUP_FAILED');}
    return backup;
  }
  async _launch(manifest,rollback) {
    if(typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
    this._abort();
    // Persist before handing control to an installer which may close this app.
    await this._checkpoint(rollback?'rollback-launched':'install-launched');
    try{await this.launchInstaller({file:this._installerPath(manifest),platform:this.platform,version:manifest.version,rollback,quitRequired:this.platform==='win32',signal:this.controller.signal});}
    catch {fail('INSTALLER_LAUNCH_FAILED');}
  }
  install() {
    return this._run('install',async()=>{
      this._platform();
      if(this.transitionLock){const pending=await this._chainState();if(pending?.terminalState==='pending')fail('TRANSITION_INVALID');}
      if(this.state.targetVersion===this.currentVersion)fail('VERSION_NOT_APPLIED');
      if(!['downloaded','snapshotting','install-ready','install-launched'].includes(this.state.phase)||!this.state.previousVersion)fail('DOWNLOAD_REQUIRED');
      const target=await this._cachedManifest(this.state.targetVersion),previous=await this._cachedManifest(this.state.previousVersion);
      if(compareVersions(target.version,this.currentVersion)<=0||previous.version!==this.currentVersion||this.state.highestVersion&&compareVersions(target.version,this.state.highestVersion)<0)fail('DOWNGRADE_BLOCKED');
      await this._verifyInstaller(target);await this._verifyInstaller(previous);
      if(typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
      await this._stop();await this._checkpoint('snapshotting');
      // Each explicit handoff attempt gets a fresh backup: the user may have
      // continued chatting after an earlier cancelled or failed OS installation.
      this.state.backup=await this._snapshot('app-update');await this._save();
      this.state.rollbackRecord={targetVersion:target.version,previousVersion:previous.version,backup:{...this.state.backup}};
      this.state.direction='update';await this._checkpoint('install-ready');
      await this._verifyInstaller(target);await this._launch(target,false);return this.status();
    });
  }
  async _closeChainAfterRollback(originVersion) {
    let chain=null;
    try {chain=await this._chainState();} catch {return;}
    if(!chain||!['pending','install-launched','completed','repair-required'].includes(chain.terminalState))return;
    try {await this._writeChain(updateChain.advance(chain,'rolled-back',originVersion));} catch {}
  }
  rollback({restoreData=false,confirmDataRestore=false}={}) {
    return this._run('rollback',async()=>{
      this._platform();
      if(typeof restoreData!=='boolean'||typeof confirmDataRestore!=='boolean')fail('RESTORE_CONFIRMATION_REQUIRED');
      if(this.transitionLock){
        let chain=await this._chainState();
        if(chain?.originInstaller&&['install-launched','completed','repair-required'].includes(chain.terminalState)){
          const current=normalizeVersion(this.currentVersion);
          const fixedVersion=normalizeVersion(chain.fixedFinalTarget.version);
          const bridgeVersion=normalizeVersion(chain.bridge.version);
          if(current!==fixedVersion&&current!==bridgeVersion)fail('ROLLBACK_UNAVAILABLE');
          chain=await this._enrichChain(chain);
          if(!chain.originBackup||typeof this.restoreSnapshot!=='function'||typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
          let origin;
          try {origin=await this._verifyOriginInstaller(chain);} catch (error) {if(error?.code==='INSTALLER_INVALID')throw error;fail('ROLLBACK_UNAVAILABLE');}
          this.state.targetVersion=chain.fixedFinalTarget.version;
          this.state.previousVersion=chain.originVersion;
          this.state.backup={id:chain.originBackup};
          await this._stop();await this._checkpoint('rolling-back');
          const currentBackup=await this._snapshot('before-app-rollback');
          this.state.preRollbackBackup=currentBackup;this.state.direction='rollback';await this._save();this._abort();
          try{await this.restoreSnapshot(chain.originBackup,{currentBackupId:currentBackup.id,signal:this.controller.signal});}catch{fail('RESTORE_FAILED');}
          // The exact a14 updater must be able to read this terminal record:
          // target a14, no schema2 manifest reference, and a closed chain.
          this.state.targetVersion=chain.originVersion;
          delete this.state.previousVersion;
          delete this.state.rollbackRecord;
          this.state.phase='rolled-back';delete this.state.errorCode;
          await this._save();
          try {await this._writeChain(updateChain.advance(chain,'rolled-back',chain.originVersion));} catch {fail('CHAIN_INVALID');}
          try {await this.launchInstaller({file:origin.file,platform:this.platform,version:chain.originVersion,rollback:true,quitRequired:this.platform==='win32',signal:this.controller.signal});}
          catch {fail('INSTALLER_LAUNCH_FAILED');}
          return this.status();
        }
      }
      const record=this.state.rollbackRecord;
      if(!record)fail('ROLLBACK_UNAVAILABLE');
      const target=await this._cachedManifest(record.targetVersion),previous=await this._cachedManifest(record.previousVersion);
      if(![target.version,previous.version].includes(this.currentVersion))fail('ROLLBACK_UNAVAILABLE');
      if((target.impact.dataMigration||!target.impact.rollbackCompatible)&&!restoreData)fail('DATA_RESTORE_REQUIRED');
      if(restoreData&&!confirmDataRestore)fail('RESTORE_CONFIRMATION_REQUIRED');
      if(restoreData&&typeof this.restoreSnapshot!=='function'||typeof this.launchInstaller!=='function')fail('CALLBACK_REQUIRED');
      this.state.targetVersion=record.targetVersion;this.state.previousVersion=record.previousVersion;this.state.backup={...record.backup};
      await this._verifyInstaller(previous);await this._stop();await this._checkpoint('rolling-back');
      const currentBackup=await this._snapshot('before-app-rollback');
      this.state.preRollbackBackup=currentBackup;this.state.direction='rollback';await this._save();this._abort();
      if(restoreData){try{await this.restoreSnapshot(this.state.backup.id,{currentBackupId:currentBackup.id,signal:this.controller.signal});}catch{fail('RESTORE_FAILED');}}
      await this._verifyInstaller(previous);
      await this._closeChainAfterRollback(previous.version);
      this.state.targetVersion=previous.version;
      delete this.state.previousVersion;
      delete this.state.rollbackRecord;
      this.state.phase='rolled-back';delete this.state.errorCode;
      await this._save();
      try {await this.launchInstaller({file:this._installerPath(previous),platform:this.platform,version:previous.version,rollback:true,quitRequired:this.platform==='win32',signal:this.controller.signal});}
      catch {fail('INSTALLER_LAUNCH_FAILED');}
      return this.status();
    });
  }
  completeVerification({healthy,version=this.currentVersion}={}) {
    return this._run('verify',async()=>{
      const expected=this.state.direction==='rollback'?this.state.previousVersion:this.state.targetVersion;
      if(typeof healthy!=='boolean'||!expected||normalizeVersion(version)!==expected||normalizeVersion(this.currentVersion)!==expected||!['awaiting-verification','awaiting-rollback-verification','repair-required','installed','rolled-back'].includes(this.state.phase))fail('VERSION_NOT_APPLIED');
      if(healthy){
        const chain=await this._chainState();
        if(chain?.terminalState==='install-launched'&&chain.fixedFinalTarget.version===expected){try{await this._writeChain(updateChain.advance(chain,'completed',expected));}catch{}}
        await this._checkpoint(this.state.direction==='rollback'?'rolled-back':'installed');
      }
      else {this.state.phase='repair-required';this.state.errorCode='VERIFICATION_FAILED';await this._save();}
      return this.status();
    });
  }
  async cancel() {
    this.controller?.abort();if(this.operation)await this.operation.catch(()=>{});
    if(this.transitionLock){let chain=await this._chainState();if(!chain){try{chain=updateChain.validate(this.transitionLock);}catch{chain=null;}}if(chain?.terminalState==='pending'){try{await this._writeChain(updateChain.advance(chain,'cancelled',chain.bridge.version));}catch{}}}
    await this._clearContinuationFailure();
    return this.status();
  }
}
module.exports={AppUpdater,UpdateError,verifyManifest,verifyModernManifest,normalizeVersion,compareVersions,protocol};
