(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSWhaleUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const workspaceActions = new Set(['workspace-status','health-check','backup-list','backup-restore','backup-delete','diagnostics-export','app-update-check','app-update-start','app-update-download','app-update-install','app-update-rollback','preferences-save']);
  const concurrentReadActions = new Set(['settings-get','workspace-status','backup-list','connections-status','settings-history','reply-style-preview','appearance-get']);
  // Read-only snapshot actions are recoverable. Their failures become an
  // in-place warning and must never look like a failed user operation (the old
  // APP-001 red banner) or block an unrelated save.
  const readWarningActions = new Set(['inspect','workspace-status']);
  const noPayloadActions = new Set(['app-update-start','settings-history','connections-status','workspace-status','health-check','backup-list','diagnostics-export','app-update-download','app-update-install','appearance-get']);
  const actions = new Set(['inspect', 'install', 'start', 'stop', 'open-panel', 'home', 'settings-get', 'settings-save', 'open-data', 'backup', 'restore', 'initial-login', 'extensions-status', 'extension-check', 'extension-update', 'extension-rollback','connections-status','settings-history','settings-restore-field','reply-style-preview','appearance-get','appearance-save',...workspaceActions]);
  const panels = new Set(['astrbot', 'models', 'memory', 'bilibili', 'qq',  'persona']);
  const extensionIds = new Set(['memory', 'memes']);
  const extensionActions = new Set(['extension-check', 'extension-update', 'extension-rollback']);
  const replyStyleDefaults = value => ({ replyStyleMode: ['inherit','natural','single','custom'].includes(value?.replyStyleMode) ? value.replyStyleMode : 'natural', replyStyleMaxBubbles: [1,2,3].includes(value?.replyStyleMaxBubbles) ? value.replyStyleMaxBubbles : 3, replyStyleInterval: typeof value?.replyStyleInterval === 'string' ? value.replyStyleInterval : '0.8,1.5', replyStylePunctuation: value?.replyStylePunctuation === 'sentence_end' ? 'sentence_end' : 'keep', replyStylePrompt: value?.replyStylePrompt !== false, replyStyleCustomRegex: typeof value?.replyStyleCustomRegex === 'string' ? value.replyStyleCustomRegex : '', replyStyleCustomCleanup: typeof value?.replyStyleCustomCleanup === 'string' ? value.replyStyleCustomCleanup : '', persona: typeof value?.persona === 'string' ? value.persona : '', hostReplyPrefix: value?.hostReplyPrefix === true, hostTtsEnabled: value?.hostTtsEnabled === true });
  const settingsDefaults = value => ({ ...value, ...replyStyleDefaults(value), dashboardPort:value?.dashboardPort??6185, qqConnectionMode:'official', defaultDelivery:'official', });
  const preferencesPayload = value => ({tray:value?.tray===true,startAtLogin:value?.startAtLogin===true,resumeAfterWake:value?.resumeAfterWake===true});
  function extensionsStatus(value) {
    if (!value || [...extensionIds].some(id => !value[id] || typeof value[id].installed !== 'boolean')) throw new Error('未能读取插件状态，请重试。');
    return Object.fromEntries([...extensionIds].map(id => [id, { ...value[id] }]));
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const settingsFields = new Set(['qqConnectionMode','officialOwnerUMO','dashboardPort','biliEnabled','proactiveEnabled','defaultDelivery','replyStyleMode','replyStyleMaxBubbles','replyStyleInterval','replyStylePunctuation','replyStylePrompt','replyStyleCustomRegex','replyStyleCustomCleanup']);
  const settingsSwitches = new Set(['biliEnabled','proactiveEnabled','replyStylePrompt']);
  function settingsPayload(value) {
    // Only serialize fields the caller actually supplied. Missing fields are not
    // user intent: they must never become false/'' defaults in a save request.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置内容无效。');
    const payload = {};
    for (const key of Object.keys(value)) {
      if (!settingsFields.has(key) || value[key] === undefined) continue;
      const item = value[key];
      if (key === 'qqConnectionMode') {
        if (![ 'official'].includes(item)) throw new Error('QQ 接入方式无效。');
        payload[key] = item;
      } else if (key === 'defaultDelivery') {
        if (!['official'].includes(item)) throw new Error('主动消息默认渠道无效。');
        payload[key] = item;
      } else if (key === 'replyStyleMode') {
        if (!['inherit', 'natural', 'single', 'custom'].includes(item)) throw new Error('回复方式无效。');
        payload[key] = item;
      } else if (key === 'replyStylePunctuation') {
        if (!['keep', 'sentence_end'].includes(item)) throw new Error('标点处理方式无效。');
        payload[key] = item;
      } else if (key === 'replyStyleMaxBubbles') {
        const count = Number(item);
        if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('目标条数应为 1–3 的整数。');
        payload[key] = count;
      } else if (key === 'replyStyleInterval') {
        const text = String(item ?? '').trim(), parts = text.split(',').map(part => Number(part.trim()));
        if (parts.length !== 2 || parts.some(part => !Number.isFinite(part) || part < 0.2 || part > 5) || parts[0] > parts[1]) throw new Error('发送间隔应为“最小,最大”，各 0.2–5 秒。');
        payload[key] = `${parts[0]},${parts[1]}`;
      } else if (key === 'replyStyleCustomRegex' || key === 'replyStyleCustomCleanup') {
        // Python is the authority for regex syntax and capture-group rules.
        // The renderer only guards transport size so a valid host-only pattern
        // is not rejected by JavaScript's different regex dialect.
        const pattern = String(item ?? '');
        if (pattern.length > 200) throw new Error('自定义规则不能超过 200 个字符。');
        payload[key] = pattern;
      } else if (key === 'officialOwnerUMO') {
        payload[key] = String(item ?? '').trim();
      } else if (key === 'dashboardPort') {
        const port = Number(item);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024–65535 之间的整数。');
        payload[key] = port;
      } else if (settingsSwitches.has(key)) {
        if (typeof item !== 'boolean') throw new Error('开关值无效。');
        payload[key] = item;
      }
    }
    return payload;
  }
  function settingsComparable(value) {
    const normalized = settingsDefaults(value || {});
    return { ...normalized, officialOwnerUMO: String(normalized.officialOwnerUMO ?? '').trim(), ...Object.fromEntries([...settingsSwitches].map(key => [key, normalized[key] === true])) };
  }
  function settingsPatch(value, baseline) {
    const payload = settingsPayload(value);
    const before = settingsComparable(baseline);
    const patch = {};
    for (const [key, next] of Object.entries(payload)) {
      if (String(before[key] ?? '') === String(next)) continue;
      if (typeof before[key] === 'boolean' && before[key] === next) continue;
      if (typeof before[key] !== 'boolean' && typeof next !== 'boolean' && before[key] === next) continue;
      patch[key] = next;
    }
    return patch;
  }
  function connectionViewModel(data) {
    const state = data.state || {};
    const view = (stage, title, description, badge, tone, action = '', actionLabel = '') =>
      ({ stage, title, description, badge, tone, action, actionLabel });
    if (data.workspace?.appUpdate?.recovery?.servicesMustRemainStopped) return view('recovery', '先完成应用更新', '当前更新或恢复尚未完成，请先处理应用设置中的提示。', '等待恢复', 'warn', 'route-settings', '查看恢复步骤');
    if (!state.installed || state.platform?.supported === false) return view('environment', '先准备运行环境', '环境准备完成后，再连接 QQ。已有配置与登录数据会保留。', '尚未准备', '', 'route-environment', '准备运行环境');
    const startup = {
      'starting-conversation': ['正在启动对话服务', '先启动消息处理服务，完成后再连接 QQ。'],
      'checking-qq': ['对话服务已启动', '正在检查已有的 QQ 连接。'],
    }[state.startup?.stage];
      if(startup)return view(state.startup.stage,...startup,'正在启动','working');
      if(!state.running)return view('official-stopped','启动官方机器人','启动对话服务并连接 QQ 官方接口。','尚未启动','','start','启动');
      const officialEntry=(data.connections?.channels||[]).find(item=>item.channel==='official');
      const settingsConfigured=data.settings?data.settings.officialConfigured===true:state.setup?.qqConfigured===true;
      const targetIssue=officialEntry?.targetIssue||'';
      const targetResolved=Boolean(officialEntry)&&targetIssue==='';
      const candidates=Array.isArray(officialEntry?.platformCandidates)?officialEntry.platformCandidates:[];
      const candidatesConfigured=candidates.some(item=>item&&item.configured===true);
      const candidatesReady=candidates.some(item=>item&&item.enable===true&&item.configured===true);
      // When the snapshot resolved one instance, its explicit configured flag is
      // authoritative. Candidate flags are only for unresolved targets (multiple
      // or deleted-bound instances). An explicit false is never overridden by a
      // different robot's credentials or by the settings summary flag.
      let credentialsConfigured=settingsConfigured;
      if(officialEntry){
        credentialsConfigured=targetResolved
          ? officialEntry.configured===true||(officialEntry.configured===undefined&&settingsConfigured)
          : candidatesConfigured||officialEntry.configured===true||(officialEntry.configured===undefined&&settingsConfigured);
      }
      if(!credentialsConfigured)return {...view('official-setup','创建或连接 QQ 官方机器人','在内置控制台扫码创建，或填写已有机器人的 AppID 与 AppSecret。','待配置','','open-panel','配置官方机器人'),panel:'qq'};
      const bound=data.settings?!!data.settings.officialOwnerUMO:state.setup?.ownerConfigured;
      if(targetIssue==='ambiguous'){
        if(!bound){
          if(!candidatesReady)return {...view('official-target','先启用官方机器人实例','检测到多个官方机器人平台，但它们当前都未启用或缺少凭据，无法完成私聊绑定。请先在 AstrBot 平台设置中启用并配置要使用的实例，再回来绑定。','待启用','warn','open-panel','检查官方配置'),panel:'qq'};
          return view('official-owner','绑定你的官方私聊','检测到多个官方机器人平台，先用个人 QQ 私聊要使用的机器人发送 /fish whoami，复制完整“本会话”到下方。不要填写普通 QQ 号码。','待绑定','warn','save-settings','保存私聊绑定');
        }
        return {...view('official-target','无法确定官方机器人实例','存在多个同 ID 的官方机器人平台，暂时无法确认要操作哪一个。请先在 AstrBot 平台设置中保留一个，再重新绑定私聊。','待确认','warn','open-panel','检查官方配置'),panel:'qq'};
      }
      if(targetIssue==='missing-bound'){
        if(!candidatesReady)return {...view('official-target','先恢复官方机器人连接','原来的官方机器人实例已不存在，当前候选实例也尚未启用或缺少凭据。请先在 AstrBot 平台设置中启用并配置实例，再重新绑定私聊。','待启用','warn','open-panel','检查官方配置'),panel:'qq'};
        return view('official-owner','重新绑定官方私聊','原来的官方机器人实例已不存在。用个人 QQ 私聊当前要使用的机器人发送 /fish whoami，重新复制完整“本会话”到下方。已保存的凭据不需要重填。','待重新绑定','warn','save-settings','保存私聊绑定');
      }
      if(officialEntry&&targetIssue==='missing')return {...view('official-setup','创建或连接 QQ 官方机器人','没有找到可用的 QQ 官方机器人平台，请先在 AstrBot 中创建或填写已有机器人。','待配置','','open-panel','配置官方机器人'),panel:'qq'};
      if(officialEntry&&officialEntry.platformEnabled===false)return {...view('official-disabled','QQ 官方机器人已停用','官方连接当前已停用；请在官方机器人配置中启用后继续使用。','已停用','','open-panel','打开官方配置'),panel:'qq'};
      if(!bound)return view('official-owner','绑定你的官方私聊','用个人 QQ 私聊机器人发送 /fish whoami，复制完整“本会话”到下方。不要填写普通 QQ 号码。','待绑定','','save-settings','保存私聊绑定');
      const officialHealth=data.workspace?.official;
      const officialConnected=officialHealth && typeof officialHealth.protocolConnected==='boolean' ? officialHealth.protocolConnected===true : (officialEntry?.protocolConnected===true || officialEntry?.health==='connected');
      if(officialConnected){
        if(state.setup?.modelConfigured===false)return view('model','配置聊天模型','官方接口已连接，接下来选择聊天模型。','QQ 已连接','good','route-intelligence','配置模型');
        return view('ready','QQ 官方机器人已连接','已确认官方网关连接。请用自己的 QQ 给机器人发一条消息，检查模型回复。','QQ 已连接','good');
      }
      if(officialHealth ? officialHealth.gatewayBlocked === true : officialEntry?.health==='blocked'){
        return {...view('official-blocked','QQ 官方连接需要处理','请在 QQ 开放平台检查机器人启用状态、凭据和网络设置。确认后在机器人配置页重新启用。','待检查','warn','open-panel','检查官方配置'),panel:'qq'};
      }
      return {...view('official-connecting','正在连接 QQ 官方接口','服务运行期间会自动尝试连接。若长时间未连通，请检查机器人状态、凭据及平台要求的出口 IP。','等待连接','working','open-panel','检查官方配置'),panel:'qq'};
  }
  function connectionSummary(data) { return { ...connectionViewModel(data), globalChannel: 'official' }; }
  function normalizeError(error) {
    // Electron prefixes every rejected ipcRenderer.invoke() with the channel name
    // and the original error class. The user-facing banner must show the action
    // message, not that transport detail.
    let message = error instanceof Error ? error.message : String(error ?? '');
    message = message.replace(/^Error invoking remote method '[^']*':\s*/i, '');
    message = message.replace(/^(?:Error|UserActionError):\s*/i, '');
    return message || '操作未完成，请重新检查状态或导出诊断';
  }
  const defaultAppearance = Object.freeze({ format: 1, material: 'frosted', revision: 0 });
  function appearanceValue(value) {
    if (value?.format !== 1 || !['frosted', 'liquid'].includes(value.material) || !Number.isInteger(value.revision) || value.revision < 0) return null;
    return { format: 1, material: value.material, revision: value.revision };
  }
  function createController({ bridge, preview = false } = {}) {
    const available = !!bridge && typeof bridge.invoke === 'function' && typeof bridge.onState === 'function';
    const subscribers = new Set();
    let data = { mode: available ? 'desktop' : preview ? 'preview' : 'unavailable', pending: '', pendingExtension: '', error: '', workspaceError: '', settingsError: '', feedback: null, retry: null, dismissedError: '', dismissedFeedbackId: '', faultFeedbackId: '', settings: null, extensions: null, extensionChecks: { memory: false, memes: false }, workspaceLoaded:false, connections:null,  settingsHistory:null, workspace:{health:null,backups:[],appUpdate:null,official:null,preferences:preferencesPayload(),diagnosticFiles:[]}, notice: '', appearance: null, appearancePending: false, appearanceError: '', state: { version: '', platform: { label: '正在读取系统信息', supported: true }, phase: 'idle', installed: false, running: false, components: [], setup: {}, panel: '' } };
    let unsubscribe;
    let faultSequence = 0;
    let activeReads = 0;
    let appearanceSequence = 0;
    let appearanceWrites = Promise.resolve();
    const emit = () => subscribers.forEach(callback => callback(data));
    function mergeAppearance(value) {
      const next = appearanceValue(value);
      const committed = data.state.appearance;
      if (!next || (committed && next.revision <= committed.revision)) return;
      data.state.appearance = next;
      if (!data.appearancePending) data.appearance = next;
    }
    function saveAppearance(material) {
      const sequence = ++appearanceSequence;
      data.appearance = { ...(data.state.appearance || defaultAppearance), material };
      data.appearancePending = true;
      data.appearanceError = '';
      emit();
      // Appearance has its own file and main-process queue. Keep its writes in
      // selection order while preserving the core operation's action fence.
      const work = appearanceWrites.catch(() => {}).then(async () => {
        try {
          const result = await bridge.invoke('appearance-save', { material });
          if (result?.error) throw new Error(String(result.error));
          if (!appearanceValue(result)) throw new Error('未能读取外观设置，请重试。');
          mergeAppearance(result);
          return result;
        } catch (error) {
          if (sequence === appearanceSequence) data.appearanceError = normalizeError(error);
          throw error;
        } finally {
          if (sequence === appearanceSequence) {
            data.appearancePending = false;
            data.appearance = { ...(data.state.appearance || defaultAppearance) };
          }
          emit();
        }
      });
      appearanceWrites = work;
      return work;
    }
    function mergeWorkspace(next) {
      if(!next||typeof next!=='object'||Array.isArray(next))throw new Error('未能读取工作空间状态，请重试。');
      for(const key of ['health','backups','appUpdate','official','diagnosticFiles'])if(Object.hasOwn(next,key))data.workspace[key]=next[key];
      if(Object.hasOwn(next,'preferences'))data.workspace.preferences=preferencesPayload(next.preferences);
    }
    function merge(next) {
      if (!next || typeof next !== 'object') return;
      const {workspace,appUpdate,connections,appearance,...state}=next;if(workspace)mergeWorkspace(workspace);
      if (Object.hasOwn(next, 'appearance')) mergeAppearance(appearance);
      if(Object.hasOwn(next,'appUpdate'))mergeWorkspace({appUpdate});
      if(Object.hasOwn(next,'connections'))data.connections=connections||null;
      // Only an explicit main-process error clear ends a dismissal. A routine
      // successful read does not mention error and must leave it intact.
      if (Object.hasOwn(next, 'error') && (next.error === undefined || next.error === null || next.error === '')) { data.dismissedError = ''; data.dismissedFeedbackId = ''; data.faultFeedbackId = ''; }
      if (Object.hasOwn(next, 'feedback') && next.feedback && typeof next.feedback === 'object') {
        // A warning is advisory and must never re-arm an action fault the user
        // already dismissed. Only a new error identity can do that.
        if (next.feedback.kind === 'error' && next.feedback.operationId) {
          if (data.faultFeedbackId && next.feedback.operationId !== data.faultFeedbackId) { data.dismissedError = ''; data.dismissedFeedbackId = ''; }
          data.faultFeedbackId = next.feedback.operationId;
        }
        data.feedback = next.feedback;
      }
      data.state = { ...data.state, ...state, platform: { ...data.state.platform, ...state.platform }, setup: { ...data.state.setup, ...state.setup } };
    }
    if (!available && preview) {
      merge({ version: '0.4.0a5', platform: { id: 'darwin-arm64', label: 'macOS · Apple Silicon', supported: true }, components: [
        { id: 'python', label: 'Python', version: '3.12', status: 'missing', detail: '将安装到独立环境' },
        { id: 'node', label: 'Node.js', version: '22 LTS', status: 'missing', detail: '用于扩展与网页能力' },
        { id: 'ffmpeg', label: 'FFmpeg', version: '6+', status: 'missing', detail: '音频与视频处理' },
        { id: 'astrbot', label: 'AstrBot', version: '4.29.4', status: 'missing', detail: '对话服务与插件管理' },
        { id: 'memory', label: '记忆插件', version: '随环境安装', status: 'missing', detail: '长期记忆与上下文' },
      ] });
      data.settings = settingsDefaults({ officialOwnerUMO: '', officialConfigured: false, biliEnabled: false, proactiveEnabled: false, hasModels: false });
      data.extensions = { memory: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false }, memes: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false } };
    }
    async function act(action, payload) {
      if (!actions.has(action)) throw new Error('不支持的操作。');
      if (action === 'open-panel' && !panels.has(payload?.panel)) throw new Error('不支持的面板。');
      if (extensionActions.has(action)) {
        if (!extensionIds.has(payload?.id)) throw new Error('不支持的插件。');
        payload = { id: payload.id };
      }
      if (action === 'extensions-status') payload = undefined;
      if(noPayloadActions.has(action))payload=undefined;
      if(action==='app-update-check'){if(!['alpha','stable'].includes(payload?.channel))throw new Error('请选择稳定版或 Alpha 更新通道。');payload={channel:payload.channel};}
      if(['backup-restore','backup-delete'].includes(action)) {
        if(typeof payload?.id!=='string'||!data.workspace.backups?.some(item=>item.id===payload.id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(payload.id)||payload.id.includes('..'))throw new Error('请选择列表中的本机备份。');
        payload={id:payload.id};
      }
      if(action==='app-update-rollback')payload={restoreData:payload?.restoreData===true,confirmDataRestore:payload?.confirmDataRestore===true};
      if(action==='appearance-save'){if(!['frosted','liquid'].includes(payload?.material))throw new Error('请选择受支持的外观材质。');payload={material:payload.material};}
      if (!available) throw new Error(preview ? '界面预览为只读模式，请在桌面应用中执行操作。' : '请在 DWhale 桌面应用中执行操作。');
      if (action === 'appearance-save') return saveAppearance(payload.material);
      const readOnly = concurrentReadActions.has(action);
      if (data.pending && (!readOnly || !concurrentReadActions.has(data.pending))) throw new Error('上一项操作仍在进行，请稍候。');
      if (!readOnly && activeReads > 0) throw new Error('上一项操作仍在进行，请稍候。');
      const resumable=['downloading','downloaded','install-ready','awaiting-verification'].includes(data.workspace.appUpdate?.phase);if(action==='app-update-start'&&(!data.state.installed||!(data.workspace.appUpdate?.canDownload||data.workspace.appUpdate?.canInstall||resumable)))throw new Error('请先准备环境并检查应用更新。');
      if(action==='app-update-download'&&data.workspace.appUpdate?.canDownload!==true)throw new Error('请先检查应用更新，或继续未完成的下载。');
      if(action==='app-update-install'&&(!data.state.installed||data.workspace.appUpdate?.canInstall!==true))throw new Error('请先准备环境并下载经过校验的应用安装包。');
      if(action==='app-update-rollback'&&data.workspace.appUpdate?.canRollback!==true)throw new Error('当前没有可回退的应用安装包和备份。');
      if(action==='app-update-rollback'&&payload.restoreData&&!payload.confirmDataRestore)throw new Error('请明确确认恢复更新前数据。');
      if (action === 'extension-update' && (!data.extensionChecks[payload.id] || data.extensions?.[payload.id]?.canUpdate !== true)) throw new Error('请先检查插件更新，确认可安装的版本。');
      if (action === 'extension-rollback' && data.extensions?.[payload.id]?.canRollback !== true) throw new Error('当前没有可回退的插件备份。');
      if (readOnly) activeReads += 1;
      else {
        data.pending = action;
        data.pendingExtension = extensionActions.has(action) ? payload.id : '';
      }
      data.error = '';
      data.notice = '';
      // A routine read or another action does not re-arm a dismissed fault. A
      // genuinely new fault carries a new operation identity and ends the old
      // dismissal in merge(); an explicit main-process clear does the same.
      if (action === 'extension-check') data.extensionChecks[payload.id] = false;
      emit();
      let retryOverride;
      try {
        if (action === 'settings-save') {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('设置请求无效。');
          const envelope = Object.hasOwn(payload, 'patch') ? payload : { patch: payload };
          if (Object.hasOwn(payload, 'patch')) {
            const keys = Object.keys(payload).sort().join(',');
            if (keys !== 'patch' && keys !== 'expectedRevision,patch') throw new Error('设置请求无效。');
            if (Object.hasOwn(payload, 'expectedRevision') && (typeof payload.expectedRevision !== 'string' || !/^[a-f0-9]{8,64}$/.test(payload.expectedRevision))) throw new Error('设置修订标识无效。');
          }
          const patch = settingsPayload(envelope.patch || {});
          if (!Object.keys(patch).length) throw new Error('没有需要保存的修改。');
          payload = { patch, ...(envelope.expectedRevision !== undefined ? { expectedRevision: envelope.expectedRevision } : {}) };
        }
        if(action==='preferences-save')payload=preferencesPayload(payload);
        const result = await bridge.invoke(action, payload);
        if (result && typeof result === 'object' && result.error) throw new Error(String(result.error));
        if (readWarningActions.has(action)) data.workspaceError = '';
        if (action === 'settings-get') data.settingsError = '';
        if (data.feedback && data.feedback.scope === action) data.feedback = null;
        if(action==='app-update-start'&&result?.canceled){mergeWorkspace(result);data.notice='安装包已准备，可稍后点击更新继续。';}
        if(workspaceActions.has(action)&&!result?.canceled) {
          mergeWorkspace(result);if(action==='workspace-status')data.workspaceLoaded=true;
          if(action==='preferences-save')data.notice='应用偏好已保存。';
          if(action==='health-check')data.notice='本机环境检查已完成。';
          if(action==='backup-delete')data.notice='所选本机备份已删除。';
          if(action==='diagnostics-export'&&result.saved)data.notice='诊断报告已保存。';
          if(action==='app-update-check')data.notice='应用更新检查已完成。';
          if(action==='app-update-download')data.notice='应用安装包已下载并校验，等待你确认安装。';
          if(['app-update-start','app-update-install','app-update-rollback','backup-restore'].includes(action)){merge({running:false,panel:''});data.notice=action==='backup-restore'?'备份已恢复，当前数据已另行备份；请检查环境和连接后启动服务。':'安装程序已打开，请完成系统安装并重新打开应用。';}
          if(action==='backup-restore'){data.settings=null;data.extensions=null;data.extensionChecks={memory:false,memes:false};}
        }
        else if (action === 'connections-status') { data.connections = result?.connections || null; }
        else if (action === 'settings-history') { data.settingsHistory = result && typeof result === 'object' ? result : null; }
        else if (action === 'settings-restore-field') { data.notice = '设置项已恢复。'; }
        else if (action === 'settings-get') { data.settings = settingsDefaults(result); }
        else if (action === 'settings-save') {
          if (result && 'officialOwnerUMO' in result) data.settings = settingsDefaults(result);
          else data.settings = settingsDefaults({ ...data.settings, ...(payload?.patch || {}) });
          data.notice = result?.changed === false ? '设置没有变化，未写入。' : '设置已保存。';
        }
        else if ((action === 'extensions-status' || extensionActions.has(action)) && !result?.canceled) {
          const next = extensionsStatus(result);
          const wasInstalled = data.extensions?.[payload?.id]?.installed;
          data.extensions = next;
          if (action === 'extension-check') {
            data.extensionChecks[payload.id] = true;
            data.notice = `${payload.id === 'memory' ? 'LivingMemory' : '表情包管理器'}检查完成。`;
          } else if (action === 'extension-update' || action === 'extension-rollback') {
            data.extensionChecks[payload.id] = false;
            merge({ running: false, panel: '' });
            const verb = action === 'extension-rollback' ? '回退' : wasInstalled ? '更新' : '安装';
            data.notice = `${payload.id === 'memory' ? 'LivingMemory' : '表情包管理器'}已${verb}，服务保持停止。请检查设置后启动服务。`;
          }
        }
        else if (action === 'backup' && !result?.canceled) data.notice = '备份已保存到所选位置。';
        else if (action === 'restore' && !result?.canceled) { data.notice = '备份已导入，请检查配置后启动服务'; data.settings = null; data.extensions = null; data.extensionChecks = { memory: false, memes: false }; }
        else if (action === 'appearance-get') mergeAppearance(result);
        else if (action === 'open-data') data.notice = '已打开数据文件夹。';
        if (result && ('phase' in result || 'components' in result || 'running' in result || 'installed' in result || 'platform' in result || 'versionMatrix' in result || 'upstreamCore' in result || 'appearance' in result || 'chrome' in result)) merge(result);
        if(['install','restore'].includes(action)&&!result?.canceled) {
          retryOverride={action:'workspace-status',payload:undefined};
          const workspace=await bridge.invoke('workspace-status');
          if(workspace?.error)throw new Error(String(workspace.error));
          mergeWorkspace(workspace);data.workspaceLoaded=true;retryOverride=undefined;
        }
        data.retry = null;
        return result;
      } catch (error) {
        const message = normalizeError(error);
        if (readWarningActions.has(action)) {
          // A failed status/health read leaves the workspace usable; keep the
          // warning local to the page instead of arming the global fault banner.
          data.workspaceError = message;
          data.retry = { action, payload };
        } else if (action === 'settings-get') {
          // Settings still loading (or a re-read): keep drafts and the skeleton;
          // never render bad values as off and never save defaults.
          data.settingsError = message;
          data.retry = { action, payload };
        } else {
          data.error = message;
          data.feedback = { kind: 'error', scope: action, message, retryable: true, active: true, operationId: `local-${++faultSequence}` };
          data.faultFeedbackId = data.feedback.operationId;
          // Never retain a settings payload containing a local access token in retry metadata.
          data.retry = retryOverride||(['settings-save','backup-restore','backup-delete','app-update-start','app-update-rollback','settings-restore-field'].includes(action) ? null : { action, payload });
        }
        throw error;
      } finally {
        if (readOnly) activeReads -= 1;
        else { data.pending = ''; data.pendingExtension = ''; }
        emit();
      }
    }
    return {
      get: () => data,
      invalidateSettingsHistory() { data.settingsHistory = null; },
      dismissError() {
        // app.js renders data.error || data.state.error. Dismissing records the
        // message that was actually visible so the same banner stays hidden even
        // when it came from main's state.error. The fault itself (state.error),
        // the action fence (pending) and activeAction are deliberately untouched.
        const visible = data.error || data.state?.error || '';
        if (!visible) return;
        // Remember both the wording and the operation identity. A successful
        // read clears feedback but keeps the persistent fault text, so the
        // wording alone must keep it hidden; a new operation with the same
        // wording must be able to surface it again.
        data.dismissedError = visible;
        data.dismissedFeedbackId = data.faultFeedbackId || '';
        data.error = '';
        data.retry = null;
        emit();
      },
      clearNotice() { if (!data.notice) return; data.notice = ''; emit(); },

      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
      async init() { if (!available) { emit(); return; } unsubscribe = bridge.onState(next => { merge(next); emit(); }); await act('inspect'); await act('workspace-status'); },
      act,
      dispose() { if (typeof unsubscribe === 'function') unsubscribe(); subscribers.clear(); },
    };
  }
  return { createController, escapeHTML, settingsPayload, settingsPatch, preferencesPayload, connectionViewModel, connectionSummary };
});
