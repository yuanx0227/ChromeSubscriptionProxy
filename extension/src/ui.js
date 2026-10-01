const $ = id => document.getElementById(id);
let current;
let busy = false;
let actionVersion = 0;
const text = (id, value) => { if ($(id)) $(id).textContent = value; };
function render(s, fill = false) {
  current = s;
  text('status', s.status);
  if ($('dot')) $('dot').className = `dot ${s.status === '代理已启用' ? 'on' : s.enabled ? 'warn' : ''}`;
  const empty = !s.subscriptionUrl;
  document.body.classList.toggle('empty', empty);
  text('count', empty ? '尚未添加订阅' : `${s.nodes.length} 条可用线路`);
  text('updated', s.updatedAt ? `更新于 ${new Date(s.updatedAt).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}` : '');
  text('rules-count', s.rules.proxy.length + s.rules.direct.length ? `${s.rules.proxy.length + s.rules.direct.length} 条自定义` : '默认规则');
  text('routing-updated', `规则：${s.routing?.sourceBuild?.replace(/^UTC /,'') || '内置版本'} UTC`);
  text('routing-error', s.routing?.error || '');
  if ($('setup')) { $('setup').hidden = !empty; $('toggle').hidden = empty; }
  text('notice', [s.updateError, s.applyError, s.proxyError, s.status === '当前节点已被移除' ? '请选择新节点；应代理的网站当前已阻断。' : ''].filter(Boolean).join('；'));
  if ($('node')) {
    $('node').replaceChildren(new Option(empty ? '请先添加订阅' : s.nodes.length ? '请选择线路' : '无可用线路', ''));
    for (const node of s.nodes) $('node').add(new Option(node.name, node.id));
    $('node').value = s.selectedId || '';
  }
  text('toggle', s.enabled ? '断开' : '连接');
  if ($('toggle')) $('toggle').classList.toggle('disconnect', s.enabled);
  text('latency', s.probeRunning ? '检测中…' : s.latency ? s.latency.ok ? `${s.latency.ms} ms` : '检测失败' : '未检测');
  if ($('latency')) $('latency').title = '预热后 3 次代理 HTTP 请求的中位数';
  if ($('url') && fill) {
    $('url').value = s.subscriptionUrl;
    $('proxy').value = s.rules.proxy.join('\n'); $('direct').value = s.rules.direct.join('\n');
  }
  if ($('unsupported')) {
    $('unsupported').replaceChildren();
    for (const p of s.unsupported) {
      const li = document.createElement('li');
      // Normalize the older cached message without requiring a subscription refresh.
      const reason = p.reason === '需要服务器提供 HTTPS 浏览器桥接节点' ? '该节点不能直接用于浏览器代理' : p.reason;
      li.textContent = `${p.name}：${reason}`;
      $('unsupported').append(li);
    }
  }
  if ($('compatibility')) {
    const showCompatibility = !empty && s.nodes.length === 0 && s.unsupported.length > 0;
    $('compatibility').hidden = !showCompatibility;
    if (!showCompatibility) $('compatibility').open = false;
    $('compatibility').querySelector('summary').textContent = '订阅中没有可用的浏览器节点';
  }
}
async function act(action, args = {}, fill = false) {
  const version = ++actionVersion;
  busy = true;
  document.querySelectorAll('button,select').forEach(x => x.disabled = action === 'probe' ? x.id === 'probe' : true);
  text('error', '');
  text('success', '');
  if (action === 'probe') text('latency', '检测中…');
  if (['connect', 'select', 'rules'].includes(action)) text('status', '正在应用…');
  try {
    const result = await chrome.runtime.sendMessage({action, ...args});
    if (version !== actionVersion) return;
    if (!result?.ok) throw new Error(result?.error || '后台服务未响应');
    render(result.data, fill);
    if (action === 'rules') text('success', '网站规则已保存');
    if (action === 'refresh' && $('url')) text('success', '订阅已更新');
    if (action === 'refreshRouting' && !result.data.routing.error) text('success', '分流规则已更新');
  } catch (e) {
    if (version !== actionVersion) return;
    text('error', e.message);
    const result = await chrome.runtime.sendMessage({action: 'status'}).catch(() => null);
    if (result?.ok && version === actionVersion) render(result.data);
  } finally {
    if (version === actionVersion) { busy = false; updateControls(); }
  }
}
function updateControls() {
    document.querySelectorAll('button,select').forEach(x => x.disabled = false);
    if ($('probe')) $('probe').disabled = current?.status !== '代理已启用' || current?.probeRunning;
    if ($('refresh')) $('refresh').disabled = !current?.subscriptionUrl;
    if ($('toggle')) $('toggle').disabled = !current?.enabled && !current?.nodes.some(n => n.id === current.selectedId);
    if ($('node')) $('node').disabled = !current?.nodes.length;
}
function bind(id, fn) { if ($(id)) $(id).addEventListener('click', fn); }
bind('settings', () => chrome.runtime.openOptionsPage());
bind('setup', () => chrome.runtime.openOptionsPage());
bind('show-url', () => {
  const visible = $('url').type === 'password';
  $('url').type = visible ? 'text' : 'password';
  $('show-url').setAttribute('aria-label', visible ? '隐藏订阅地址' : '显示订阅地址');
  $('show-url').title = visible ? '隐藏订阅地址' : '显示订阅地址';
});
bind('toggle', () => act(current?.enabled ? 'disconnect' : 'connect'));
bind('probe', () => act('probe'));
bind('refresh', () => act('refresh'));
bind('refresh-routing', () => act('refreshRouting'));
bind('import', () => act('refresh', {url: $('url').value.trim()}, true));
bind('save-rules', () => act('rules', {proxy: $('proxy').value, direct: $('direct').value}));
if ($('node')) $('node').addEventListener('change', () => act('select', {id: $('node').value}));
await act('status', {}, true);
// Refresh background recovery feedback in an already-open popup/options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (busy || !((area === 'local' && changes.config) || (area === 'session' && changes.proxyHealth))) return;
  chrome.runtime.sendMessage({action:'status'}).then(result => {
    if (result?.ok && !busy) { render(result.data); updateControls(); }
  }).catch(() => {});
});
