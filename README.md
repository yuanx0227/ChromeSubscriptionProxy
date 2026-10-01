# 晴空 · Chrome 订阅代理 / Qingkong · Chrome Subscription Proxy

**[中文](README.md) | [English](README.en.md)**

A Manifest V3 proxy extension for Chrome on Windows: import a CLASH subscription, select a node, and use Smart routing without an extension account or a local proxy core. See the [English README](README.en.md) for installation, architecture and development.

Windows Chrome 个人使用的无登录代理扩展。导入原 CLASH 订阅，手动选线，使用 Smart 分流。配套服务器服务把各人的 VLESS/TCP/REALITY 身份桥接成独立的 HTTPS 入口，继续由原 3x-ui 计量和执行限制。

**历史部署记录：2026-09-27 完成服务器部署与主要链路验收。** 当时原 CLASH 地址保持不变，每个原订阅包含原 VLESS 节点及自己的 HTTPS 浏览器节点，无需新增订阅地址。该记录不是对当前线上状态的重新检查；证据见 [部署验收记录](docs/DEPLOYMENT-RESULT.md)。

## 安装扩展

当前版本 **0.3.6**，断网或检测失败后每 30 秒自动复查，成功后清除异常提示；后台休眠后继续恢复检查。保留精简布局和大字号，接入 sr_cnip 有序规则及每日更新。规则发布的历史部署证据见 [规则部署记录](docs/RULES-DEPLOYMENT-RESULT.md)。CRX3 包由本地 `npm run pack` 生成，适用于支持该安装渠道的环境；当前 Windows Chrome 请使用下列未打包目录加载方式，开发者模式不会解除非商店 CRX 的来源限制。已安装目录版本只需点击重新加载，不需要移除。

从仓库取得源码后，在项目根目录使用 **Node.js 22+** 执行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

构建生成 `dist/extension`。规则快照已随源码提供，构建不需要重新下载规则。Git 仓库只保存源码和文档，`dist/`、`releases/`、签名私钥、临时工作和第三方参考包不入库。

1. Chrome 打开 `chrome://extensions`，打开“开发者模式”。
2. 选择“加载已解压的扩展程序”，选择本项目的 `dist/extension` 目录。
3. 扩展“设置”中粘贴原 HTTPS CLASH 地址，保存并更新。
4. 选择可用的浏览器节点，点击“连接”。“代理已启用”只表示 Chrome 已接受配置；“检测延迟”单独检查实际代理请求。

**订阅前提：**顶层 `proxies` 必须包含 `type: http`、`tls: true`、有效服务器和端口，以及独立的用户名、密码。只有原始 VLESS/TCP/REALITY 节点的订阅需要先部署配套服务器桥接；扩展本身不能直接运行这些协议。

订阅与凭据只保存在本机扩展存储，不发送到本项目的其他服务，不跨设备同步。访问权限覆盖全部网站，是为了代理认证及订阅请求；没有内容脚本，不读取网页 DOM。扩展存储并非加密保险箱，同一 Windows 用户下能够访问浏览器配置的程序可能读取其中内容。

以下截图使用虚构示例节点。

![设置页](docs/screenshots/settings-v3.png)

![弹窗示例](docs/screenshots/popup-v3.png)

无痕支持：重新加载后进入扩展详情，开启“在无痕模式下启用”。配置与普通窗口共用，见 [验证记录](docs/INCOGNITO.md)。

## 行为

- 测延迟先预热一次，再显示 3 次代理 HTTP 请求的中位数；首次建连耗时不混入结果。代理事件先静默复核，连续两次无法访问检测地址才显示提示。详见 [0.3.5 检测修复与实测](docs/PROBE-0.3.5.md)。
- 出现检测异常后，后台每 30 秒复查当前节点；检测成功后清除提示和感叹号、停止定时检查。弹窗关闭和 MV3 后台休眠不取消恢复任务；主动断开、换节点或改配置会取消旧检测。自动复查不生成手动测速数值。见 [0.3.6 网络恢复修复](docs/NETWORK-RECOVERY-0.3.6.md)。Chrome 调度或设备休眠可能推迟检查。

- 已有可用浏览器节点时隐藏原协议节点的不兼容提示；没有可用浏览器节点时才提示，不要求用户重复配置服务器。

- 支持顶层 `proxies` 中带独立账号的 `type: http`、`tls: true` 节点；不支持远程 provider、跳过证书验证或单独指定不同 SNI。
- Smart：本机/私网及保留域名 → 自定义域名（更具体者优先）→ sr_cnip 原始顺序（域名、关键词、IP、GEOIP、FINAL）。多地址解析只有全部按规则判定为直连才直连。
- 订阅源和规则更新域名保留直连；`www.gstatic.com` 保留用于强制经当前节点的手动延迟检测。
- 应代理的请求没有 DIRECT 兜底；选中节点被移除时，以不可用代理保持这些请求失败，等待手动重选。
- 每日及手动更新；更新失败继续缓存。有效空订阅或已不包含原节点的订阅会撤销原选择的可用性。
- 重启恢复连接意图；其他扩展或策略控制代理时报告冲突。断开只释放本扩展设置。
- 不承诺系统级断网保护，无痕窗口需在扩展详情中手动允许，与普通窗口共用配置；WebRTC、其他应用和其他不遵循浏览器代理的通道不在保护范围内。
- 首版不提供 Mini、全局模式、自动选线、所有节点探测、SUB 导入。

## 项目结构

| 路径 | 用途 |
|---|---|
| `dist/extension` | 已构建、可直接加载的扩展 |
| `extension/src` | MV3 后台、订阅解析、PAC、UI |
| `extension/public` | manifest、页面、样式 |
| `server` | 只读面板同步、订阅适配、Xray 桥接配置与 supervisor |
| `docs/design/SPEC.md` | 已确认需求规格 |
| `docs/DEPLOYMENT.md` | 具体部署边界、配置、验收和撤回方式 |
| `docs/IMPLEMENTATION.md` | 模块和证据边界 |
| `docs/reference` | 本机第三方研究资料，仅供参考，不进入 Git 仓库或构建 |
| `checks` | 核心规则、身份隔离及隔离浏览器检查 |
| `scripts` | 构建与开发时更新规则 |

## 开发

Node.js 22+、Python 3.9+（服务器已验证 Python 3.9.25）。从项目根目录执行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server/requirements.txt
```

生成 CRX：运行 `npm run pack`，输出到 `releases/`。首次由 Chrome 生成签名私钥，保存在 `signing/qingkong.pem`；后续自动复用，保持扩展 ID 一致。私钥不随包分发，已排除 Git 跟踪，请保留。

服务器配置模板为 [`server/config.example.json`](server/config.example.json)，其中占位符需要按自己的环境填写；配套服务器使用 Python、Xray、Caddy、systemd 和 nftables，集成与撤回步骤见 [部署清单](docs/DEPLOYMENT.md)。真实部署配置、端口注册表、订阅路径、UUID、账号、密码和私钥不得提交到仓库。

规则已随项目提供，构建不需要再次下载。开发者可用 `python scripts/update-routing.py` 更新内置快照；正式自动更新由服务器每日生成 JSON、插件每日校验获取。下载/解析失败保留上一版本和自定义规则。来源及许可见 `docs/THIRD_PARTY.md`，新增任务部署步骤见 `docs/RULES-UPDATE.md`。

实现说明见 `docs/IMPLEMENTATION.md`，线上验证结果及未覆盖项见 `docs/DEPLOYMENT-RESULT.md`。真实 Chrome 导入、代理出口、按人计量、停用、额度和身份轮换已执行验收；未模拟服务器整机重启或真实证书续期。

这些验收描述的是历史记录。0.3.6 自动恢复改动的定向隔离 Chrome 检查见 [网络恢复说明](docs/NETWORK-RECOVERY-0.3.6.md)，不包含用户日常 Chrome 与真实断网恢复的现场结果。

## 许可与第三方资料

第三方程序和数据各自遵循其许可证，见 [第三方资料](docs/THIRD_PARTY.md) 和 `docs/licenses/`。转换后的 sr_cnip 规则列表遵循 CC BY-SA 4.0，国内 IP 数据遵循 MIT；这些数据许可证不扩展到独立程序代码。本仓库目前未为独立程序代码声明开源许可证。用户提供的第三方 CRX 和解包源码只用于研究，不进入产品构建或本仓库。
