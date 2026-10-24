const $ = id => document.getElementById(id);
let current;
let busy = false;
let actionVersion = 0;
let nodesKey = '';
let successTimer;
const text = (id, value) => { if ($(id)) $(id).textContent = value; };
const time = t => new Date(t).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
const domains = id => $(id).value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
// Background status strings remain the contract; the UI only derives a tone and friendlier wording.
const STATUS = {
  '代理已启用': ['on', '已连接'],
  '关闭': ['off', '未连接'],
  '代理控制冲突': ['warn', '代理被其他扩展占用'],
  '配置失败': ['error', '代理配置失败'],
  '当前节点已被移除': ['warn', '线路已失效'],
};
function renderHero(s, empty) {
  const hero = $('hero');
  let [tone, label] = STATUS[s.status] || ['warn', s.status];
  if (tone === 'on' && s.proxyError) tone = 'warn';
  hero.dataset.state = empty ? 'empty' : tone;
  hero.classList.toggle('enabled', s.enabled);
  text('status', label);
  text('current', empty ? '尚未添加订阅' : s.nodes.find(n => n.id === s.selectedId)?.name || (s.nodes.length ? '请选择线路' : '无可用线路'));
  const action = s.enabled ? '断开' : '连接';
  $('toggle').setAttribute('aria-label', action);
  $('toggle').title = action;
  const latency = s.latency;
  text('latency', s.probeRunning ? '检测中…' : latency ? latency.ok ? `${latency.ms} ms` : '检测失败' : '未检测');
  $('latency-box').dataset.level = s.probeRunning ? 'pending' : !latency ? '' : !latency.ok ? 'fail' : latency.ms < 300 ? 'good' : latency.ms < 600 ? 'fair' : 'slow';
}
function renderNodes(s, empty) {
  const list = $('nodes');
  // Rebuild only when the node set changes, so background refreshes keep focus and scroll.
  const key = JSON.stringify(s.nodes.map(n => [n.id, n.name]));
  if (key !== nodesKey) {
    nodesKey = key;
    list.replaceChildren(...s.nodes.map(node => {
      const item = document.createElement('label'), input = document.createElement('input');
      const name = document.createElement('span'), tag = document.createElement('span');
      item.className = 'node';
      input.type = 'radio'; input.name = 'node'; input.value = node.id;
      name.className = 'node-name'; name.textContent = name.title = node.name;
      tag.className = 'node-tag'; tag.textContent = '使用中';
      item.append(input, name, tag);
      return item;
    }));
  }
  for (const input of list.querySelectorAll('input')) {
    input.checked = input.value === s.selectedId;
    input.parentElement.classList.toggle('live', input.checked && s.status === '代理已启用');
  }
  text('count', empty ? '' : `${s.nodes.length} 条可用线路`);
  text('nodes-empty', empty ? '保存订阅后在这里选择线路' : '订阅中没有可用的浏览器节点');
  $('nodes-empty').hidden = s.nodes.length > 0;
  if (!$('unsupported')) return;
  $('unsupported').replaceChildren(...s.unsupported.map(p => {
    const li = document.createElement('li');
    // Normalize the older cached message without requiring a subscription refresh.
    li.textContent = `${p.name}：${p.reason === '需要服务器提供 HTTPS 浏览器桥接节点' ? '该节点不能直接用于浏览器代理' : p.reason}`;
    return li;
  }));
  $('compatibility').hidden = empty || !s.unsupported.length;
  $('compatibility').querySelector('summary').textContent = `${s.unsupported.length} 个节点不支持浏览器代理`;
}
function renderRules(s) {
  if (!$('rules-count')) return;
  const custom = s.rules.proxy.length + s.rules.direct.length;
  text('rules-count', custom ? `${custom} 条自定义` : '默认规则');
  const build = s.routing?.sourceBuild?.replace(/^UTC /, '').slice(0, 16);
  text('routing-updated', [build ? `规则版本 ${build} UTC` : '内置规则', s.routing?.checkedAt ? `检查于 ${time(s.routing.checkedAt)}` : ''].filter(Boolean).join(' · '));
  text('routing-error', s.routing?.error || '');
}
function renderDraft() {
  if (!$('proxy') || !current) return;
  let dirty = false;
  for (const id of ['proxy', 'direct']) {
    const list = domains(id);
    text(`${id}-count`, list.length ? `${list.length} 个域名` : '');
    dirty ||= list.join('\n') !== current.rules[id].join('\n');
  }
  $('rules-dirty').hidden = !dirty;
}
// fill lists the form fields to overwrite from saved state, so one save never discards another section's draft.
function render(s, fill = []) {
  current = s;
  const empty = !s.subscriptionUrl;
  document.body.classList.toggle('empty', empty);
  renderHero(s, empty);
  renderNodes(s, empty);
  if ($('setup')) $('setup').hidden = !empty;
  text('updated', s.updatedAt ? `更新于 ${time(s.updatedAt)}` : '');
  text('notice', [s.updateError, s.applyError, s.proxyError, s.status === '当前节点已被移除' ? '请选择新节点；应代理的网站当前已阻断。' : ''].filter(Boolean).join('；'));
  if (fill.includes('url') && $('url')) $('url').value = s.subscriptionUrl;
  if (fill.includes('rules') && $('proxy')) {
    $('proxy').value = s.rules.proxy.join('\n'); $('direct').value = s.rules.direct.join('\n');
  }
  renderRules(s);
  renderDraft();
}
function success(message) {
  text('success', message);
  clearTimeout(successTimer);
  successTimer = setTimeout(() => text('success', ''), 4000);
}
async function act(action, args = {}, fill = []) {
  const version = ++actionVersion;
  const focused = document.activeElement;
  busy = true;
  // A probe leaves everything else usable, so disconnect/select can cancel it.
  document.querySelectorAll('button,input[type=radio]').forEach(x => x.disabled = action === 'probe' ? x.id === 'probe' : true);
  text('error', '');
  clearTimeout(successTimer); text('success', '');
  if (action === 'probe') text('latency', '检测中…');
  if (['connect', 'disconnect', 'select', 'rules'].includes(action)) { $('hero').dataset.busy = ''; text('status', '正在应用…'); }
  try {
    const result = await chrome.runtime.sendMessage({action, ...args});
    if (version !== actionVersion) return;
    if (!result?.ok) throw new Error(result?.error || '后台服务未响应');
    render(result.data, fill);
    if (action === 'rules') success('网站规则已保存');
    if (action === 'refresh') success('订阅已更新');
    if (action === 'refreshRouting' && !result.data.routing.error) success('分流规则已更新');
  } catch (e) {
    if (version !== actionVersion) return;
    text('error', e.message);
    const result = await chrome.runtime.sendMessage({action: 'status'}).catch(() => null);
    if (result?.ok && version === actionVersion) render(result.data);
  } finally {
    if (version === actionVersion) {
      busy = false; updateControls();
      // Disabling controls drops keyboard focus; return it (a rebuilt radio falls back to the checked one).
      if (focused?.isConnected) focused.focus({preventScroll: true});
      else if (focused?.name === 'node') document.querySelector('#nodes input:checked')?.focus({preventScroll: true});
    }
  }
}
function updateControls() {
  delete $('hero').dataset.busy;
  document.querySelectorAll('button,input[type=radio]').forEach(x => x.disabled = false);
  if ($('probe')) $('probe').disabled = current?.status !== '代理已启用' || current?.probeRunning;
  if ($('refresh')) $('refresh').disabled = !current?.subscriptionUrl;
  $('toggle').disabled = !current?.enabled && !current?.nodes.some(n => n.id === current.selectedId);
}
function bind(id, fn) { if ($(id)) $(id).addEventListener('click', fn); }
bind('settings', () => chrome.runtime.openOptionsPage());
bind('setup', () => chrome.runtime.openOptionsPage());
bind('show-url', () => {
  const visible = $('url').type === 'password', label = visible ? '隐藏订阅地址' : '显示订阅地址';
  $('url').type = visible ? 'text' : 'password';
  $('show-url').classList.toggle('revealed', visible);
  $('show-url').setAttribute('aria-label', label);
  $('show-url').title = label;
});
bind('toggle', () => act(current?.enabled ? 'disconnect' : 'connect'));
bind('probe', () => act('probe'));
bind('refresh', () => act('refresh'));
bind('refresh-routing', () => act('refreshRouting'));
bind('import', () => {
  const url = $('url').value.trim();
  // The background falls back to the saved address for an empty value; never report that as a new import.
  if (!url) { text('error', '请输入订阅地址'); $('url').focus(); return; }
  act('refresh', {url}, ['url']);
});
bind('save-rules', () => act('rules', {proxy: $('proxy').value, direct: $('direct').value}, ['rules']));
$('nodes').addEventListener('change', e => act('select', {id: e.target.value}));
if ($('url')) $('url').addEventListener('keydown', e => { if (e.key === 'Enter') $('import').click(); });
for (const id of ['proxy', 'direct']) if ($(id)) $(id).addEventListener('input', renderDraft);
text('version', `v${chrome.runtime.getManifest().version}`);
await act('status', {}, ['url', 'rules']);
// Refresh background recovery feedback in an already-open popup/options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (busy || !((area === 'local' && changes.config) || (area === 'session' && changes.proxyHealth))) return;
  chrome.runtime.sendMessage({action:'status'}).then(result => {
    if (result?.ok && !busy) { render(result.data); updateControls(); }
  }).catch(() => {});
});
