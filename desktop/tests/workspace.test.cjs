const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('workspace IPC is main-frame only and rejects update URLs and arbitrary backup paths',()=>{const {validateRequest}=require('../lib/security.cjs');const shell={mainFrame:{}},event={sender:shell,senderFrame:shell.mainFrame};for(const action of ['workspace-status','health-check','diagnostics-export','app-update-start'])assert.doesNotThrow(()=>validateRequest(event,shell,action));assert.doesNotThrow(()=>validateRequest(event,shell,'app-update-check',{channel:'alpha'}));assert.throws(()=>validateRequest(event,shell,'app-update-check',{channel:'alpha',url:'https://evil.test'}));assert.throws(()=>validateRequest(event,shell,'backup-restore',{id:'../../data'}));assert.throws(()=>validateRequest({sender:{},senderFrame:{}},shell,'workspace-status'));});
test('pending update recovery fences actual start dispatcher before any service start',async()=>{const file=path.resolve(__dirname,'../main.cjs'),native=require('node:module').createRequire(file);const app={setName(){},getVersion:()=> '0.3.0-alpha.3',requestSingleInstanceLock:()=>false,quit(){}};const box={require:id=>id==='electron'?{app,protocol:{registerSchemesAsPrivileged(){}}}:native(id),__dirname:path.dirname(file),process,module:{exports:{}},setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nglobalThis.testHarness={perform,set(){state.installed=true;appUpdater={status:async()=>({recovery:{servicesMustRemainStopped:true}})};supervisor={start:async()=>{throw Error("SHOULD_NOT_START")}};extensions={run:async()=>({})}}};',box);box.testHarness.set();await assert.rejects(box.testHarness.perform('start'),/更新|回退|修复/);});

test('one-action update IPC rejects renderer installer locations and URLs',()=>{
 const {validateRequest}=require('../lib/security.cjs');const shell={mainFrame:{}},event={sender:shell,senderFrame:shell.mainFrame};
 for(const payload of [{file:'C:\\other.exe'},{directory:'D:\\other'},{url:'https://evil.invalid'}])assert.throws(()=>validateRequest(event,shell,'app-update-start',payload));
});

test('workspace snapshot is read-only and does not run a full health check', async () => {
  const { Workspace } = require('../lib/workspace.cjs');
  let healthCalls = 0, backupCalls = 0;
  const workspace = new Workspace({
    isInstalled: () => true,
    operations: { health: async () => { healthCalls += 1; return { checks: [], summary: { requiredFailures: 0, warnings: 0 } }; }, backups: async () => { backupCalls += 1; return []; } },
    appUpdater: { status: async () => ({ phase: 'idle' }) },
    napcat: { status: async () => ({ running: false }) },
    getQQStatus: async () => ({ running: false }),
    preferences: { read: async () => ({ tray: false, startAtLogin: false, resumeAfterWake: false }) },
  });
  const snapshot = await workspace.perform('workspace-status');
  assert.equal(healthCalls, 0);
  assert.equal(backupCalls, 1);
  assert.equal(snapshot.health, null);
  await workspace.perform('health-check');
  assert.equal(healthCalls, 1);
  const full = await workspace.status();
  assert.equal(healthCalls, 2);
  assert.ok(full.health);
});

test('the visible primary update action continues a pending chain instead of restarting it',async()=>{
 const {Workspace}=require('../lib/workspace.cjs');
 const calls=[];
 const appUpdater={transitionLock:{chainId:'chain-1'},status:async()=>({phase:'downloading',targetVersion:'0.4.0a1',canDownload:false,canInstall:false}),download:async()=>calls.push('download'),install:async()=>calls.push('install'),continueTransition:async()=>calls.push('continue')};
 const workspace=new Workspace({appUpdater,isInstalled:()=>true,isClosing:()=>false,confirmUpdate:async()=>{calls.push('confirm');return true;},afterInstaller:async()=>calls.push('quit-handoff')});
 const result=await workspace.perform('app-update-start');
 assert.deepEqual(calls,['confirm','continue','quit-handoff']);
 assert.equal(result.appUpdate.phase,'downloading');
});

test('canceling a pending chain update leaves the chain untouched and does not schedule exit',async()=>{
 const {Workspace}=require('../lib/workspace.cjs');
 const calls=[];
 const appUpdater={transitionLock:{chainId:'chain-2'},status:async()=>({phase:'install-ready',targetVersion:'0.4.0a1'}),download:async()=>calls.push('download'),install:async()=>calls.push('install'),continueTransition:async()=>calls.push('continue')};
 const workspace=new Workspace({appUpdater,isInstalled:()=>true,isClosing:()=>false,confirmUpdate:async()=>{calls.push('confirm');return false;},afterInstaller:async()=>calls.push('quit-handoff')});
 const result=await workspace.perform('app-update-start');
 assert.deepEqual(calls,['confirm']);
 assert.equal(result.canceled,true);
});
