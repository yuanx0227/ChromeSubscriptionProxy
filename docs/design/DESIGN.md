# Chrome 订阅代理设计讨论

状态：访谈决策已收敛。日期：2026-09-27。本文保留讨论过程；最终行为与实施范围以SPEC.md为准，等待整份设计的最终确认，不构成部署授权。

## 已明确的需求

1. 产品为 Chrome 插件，参考已经分析的 iGuge 实现和核心使用流程。
2. 使用插件无需注册或登录账号，由用户配置订阅地址。
3. 用户拥有已部署 Xray 的搬瓦工服务器，可导出 SUB 和 CLASH 订阅。
4. 首先支持其中一种订阅格式，选择尚未确定。
5. 首版范围已确认：订阅导入/更新、手动节点切换、一键连接、Smart 智能分流、自定义代理/直连域名、延迟显示和连接状态。Q7 已收窄为只做 Smart，Mini 暂不需要；自动选最快节点延后。
6. 首先供用户个人在 Windows Chrome 使用。
7. 安装形态已确认：只安装 Chrome 插件，不要求电脑额外安装本地代理核心。
8. 用户接受设计新增标准 HTTPS 代理入口，并优先支持 CLASH 订阅。此处确认架构方向，实际服务、端口、证书、订阅地址和部署步骤尚未确定。
9. Q5 明确要求使用现有面板生成的 CLASH 订阅地址。用户随后再次表述“不新增一个专用的 CLASH 订阅地址”，按字面保留此约束，不据“后悔了”推翻明确的否定要求。
10. 应走代理的请求失败时不自动直连；正常直连目标继续可访问。
11. Smart 优先级已确认：本机/局域网直连 → 自定义域名规则 → 默认国内域名直连 → 中国大陆 IP 直连 → 其他及无法判断的目标走代理。
12. 重启恢复连接状态，持久保存上次有效订阅；每日自动更新，更新失败继续使用缓存并提示。首次没有有效订阅时不能连接。仅本机保存，不做跨设备同步。
13. 用户已提供 `bwh.yxzyl.cn` 上的既有订阅地址作为只读兼容分析对象；完整路径含访问凭据，不写入设计文档。
14. 订阅更新删除当前节点时，提示用户手动重选，不自动切换出口；同一节点凭据或证书参数更新时自动应用。
15. 其他扩展控制代理时仅提示冲突，用户自行处理；主动断开时释放本插件代理设置，不自动禁用其他扩展。
16. Q13接受保持订阅URL不变，在服务端补充HTTPS节点的处理服务方案。Q16随后引出关键新约束：服务器供用户和朋友使用，每人需要自己的订阅/节点身份和独立流量统计，因此全局共享同一HTTPS凭据的inline provider方案排除。处理服务方案也必须重新评估用户身份和计量映射，不能只拼接共享节点。
17. 首版只对当前选中节点手动检测实际代理请求延迟，所有节点并行测速延后。
18. 首版以已解压插件目录交付，使用Chrome开发者模式加载。
19. 每位使用者需独立订阅、节点认证身份及流量归属；Q17确认插件流量必须进入现有3x-ui的各人客户端记录，与其它客户端累计，并沿用原额度/到期设置。仅提供额外计数器或面板外统计不满足要求。
20. Q18已确认按用户桥接原VLESS身份的方案：浏览器仅使用HTTPS代理，服务器桥接继续通过原节点认证和计量。
21. Q19已确认首版完整支持VLESS/TCP/REALITY节点；订阅中其它协议明确标记暂不支持，不伪装成兼容节点。
22. Q20已确认面板新增/删除用户、更换UUID后自动同步浏览器节点与凭据，目标一分钟内生效，允许必要的插件连接短暂重连；桥接进程重载不重启原核心。
23. 发现Chrome可复用同一代理地址的有效认证缓存，不能仅靠onAuthRequired保证同端口不同账号的切换；Q21已确认以每个原节点身份一个稳定端口替代Q18的单端口实现细节。当前6个身份拟用18443–18448。

参考材料：同一 outputs 目录下的 iGuge 静态分析报告与 `igg-2.3.8-source`。已有其他会话的代理入口方案在本地文档中明确标记为撤回，不作为本轮已接受方案。

## 当前事实

- iGuge 的 Chrome 路径使用 PAC 和 Chrome 代理设置，节点认证由浏览器扩展事件提供；iGuge 的订阅替代方案需要自行提供节点、规则和持久化管理。
- SUB/CLASH 描述节点信息；读取一种订阅格式与支持其中节点的连接协议是两件独立的事。
- 已对用户给定的订阅 URL 做只读 GET：HTTP 200，`application/yaml; charset=utf-8`，472 字符；包含 1 个 VLESS 节点与 1 个 select 组，出现 REALITY 和 TLS 配置。没有 HTTP/HTTPS 代理节点，没有 proxy-providers 或 rule-providers。
- 该订阅当前可被 CLASH 解析，但没有本方案纯 Chrome 扩展可直接连接的节点。VLESS 节点中的 TLS 标记不改变其协议类型。
- 用户随后明确提供 SSH 连接信息并要求直接核对服务器。本轮已通过 SSH 只读查询版本、数据库配置、运行配置与 Caddy 路由；没有修改服务器、试连代理节点或实现插件。SSH 密码仅交互输入，不写入本地脚本或设计文档。
- 当前服务器面板版本为 3x-ui 3.8.5；数据库与运行配置均只有一个 VLESS/TCP/REALITY 代理入站，端口 10443；数据库内该入站有6个客户端记录。x-ui 与 Caddy 服务运行中，面板监听127.0.0.1:2053，订阅监听127.0.0.1:2096，由Caddy转发。
- 当前 `subClashEnable=true`、`subClashEnableRouting=true`，`subClashRules` 为3974619字符/89941行；无proxies或proxy-groups键，只有rules。普通 GET 返回472字符。官方3.8.5源码证明：配置的Clash路径不是legacy；自定义设置在订阅服务初始化时读入，数据库值不代表运行服务已加载。因此不能凭长度推断超限，也不将切换User-Agent当作解决办法；本轮没有为排查该差异重启服务。
- 用户提供的订阅路径与数据库的 `subClashPath/subClashURI` 一致，实际运行面板路径为 `/usr/local/x-ui/x-ui`，没有额外指定数据库目录环境变量。
- 已核对官方3.8.5源码：标准HTTP/HTTPS入站没有原生Clash导出分支。自定义内联YAML可通过 `proxies` 覆盖整个自动列表，不是自动追加；远程规则仅允许代理组、rule-providers和rules，不能注入proxies。该限制需要明确取舍，不能承诺新增HTTP入站就会自动出现于原订阅。
- 新发现：本地自定义YAML还可以加入独立的 `proxy-providers` 键，使用Mihomo标准 `type: inline` 和 `payload` 携带HTTPS节点；不写顶层 `proxies` 即可保留面板自动节点列表。扩展必须解析这类内联provider。该全局设置会让其他有效CLASH订阅也获得所配置节点及其凭据，Q16正在确认此可见范围。
- 公开页面调查使用 Playwright。主代理因 profile 占用，对用户给出的订阅采用直接 HTTP 读取，只显式保存脱敏统计。另一个调查上下文的 Playwright 导航生成页面快照；主代理已确认其在本工作目录的.playwright-mcp目录存在。初次清理被自动审批以 `blocked by policy` 拒绝；用户明确授权删除后，再次执行同一文件的删除仍被自动审批拒绝。文件未删除，需要手动清理；没有更换工具绕过拒绝。
- 已通过 Playwright 阅读 Chromium 官方 GitHub 源码镜像：Chrome 原生代理支持标准 HTTP/HTTPS/SOCKS 类代理；普通扩展不能把 VLESS/VMess/Trojan/Shadowsocks/REALITY 节点直接作为对应协议的代理连接。HTTPS 代理是 HTTP 代理协议加 TLS，与其他节点协议外层使用 TLS 不等价。
- Chrome Apps 的原始 socket 示例不适用于普通 MV3 扩展；Native Messaging 需要额外本地程序，不符合 Q3 的安装约束。

## 设计树

| 决策 | 前置条件 | 当前状态 |
|---|---|---|
| 核心功能范围，包括是否首版自动选线 | 用户对“像 iGuge”的产品定义 | Q1 已确认上述核心范围，自动选线延后 |
| 使用人群与操作系统 | 无 | Q2 已确认个人使用、Windows Chrome |
| 安装形态：仅扩展，还是允许本地协议核心 | 用户对安装体验及协议接入方式的取舍 | Q3 已确认纯 Chrome 插件 |
| 服务器是否允许增加浏览器可用入口 | 纯扩展已确认 | Q4 已接受设计新增标准 HTTPS 入口 |
| SUB 或 CLASH 优先 | 纯扩展与标准 HTTPS 入口已确认 | Q4 已确认 CLASH 优先 |
| 新增专用订阅地址，还是复用现有面板导出地址 | CLASH 和 HTTPS 入口已确认 | Q5 已确认必须现有面板地址，且再次明确不新增专用地址 |
| 确认实际订阅及面板对 HTTPS 节点的导出能力 | Q5 必须现有地址 | 已确认面板3.8.5不原生自动导出HTTPS节点，进入Q13架构取舍 |
| 原地址前增加订阅处理服务，还是定制面板导出 | 当前面板导出限制和独立用户计量 | Q13接受处理服务；新增独立计量需求后待核实身份/计量能力 |
| 内联provider带来的全局节点可见范围 | 每人自己的节点身份与独立流量 | Q16明确多人使用且需独立计流量，排除全局共享凭据方案 |
| HTTPS入口能否按认证用户产生流量统计 | 当前Xray版本和实现 | 源码确认可统计，但直接加HTTP账号无法自动沿用原停用生命周期 |
| 用户统计和限制怎样完整沿用 | Q17必须进入原面板记录 | Q18已接受独立桥接核心经原VLESS身份转发 |
| 首版原节点协议范围 | 实际订阅与桥接核心 | Q19已确认VLESS/TCP/REALITY优先 |
| 用户与UUID变更同步 | 面板作为用户身份来源 | Q20已确认自动同步，目标一分钟内，可短暂重连插件 |
| 浏览器代理认证缓存的隔离 | 每个节点身份须正确转发和计量 | Q21已确认每个原节点身份独立稳定端口 |
| 流量是否必须合并到现有面板的每人记录 | 用户对节点与账号的定义 | Q17已确认必须累计到现有3x-ui记录并沿用原额度/到期设置 |
| 订阅更新、缓存与无网启动 | 输入格式与使用范围 | Q10 已确认持久缓存、重启恢复、每日更新 |
| 分流模式和冲突优先级 | 核心功能范围与代理架构 | Q7 仅 Smart；Q9 已确认域名加 IP 的五级优先级 |
| 节点故障是否允许自动直连 | 代理架构与分流边界 | Q6 已确认不自动直连 |
| 订阅更新导致当前节点消失 | 手动选线和不自动直连 | Q11 已确认手动重选；同节点凭据更新自动应用 |
| 与其他扩展冲突、主动断开 | 使用范围和代理控制权 | Q12 已确认仅提示冲突，断开释放本插件配置 |
| 订阅凭据和节点凭据的存储方式 | 使用范围与架构 | 本机扩展持久保存，不同步；服务端隔离映射、日志脱敏，详见SPEC |
| 延迟显示范围 | 手动选线和首版范围 | Q14已确认只手动检测当前选中节点 |
| 首版安装交付 | 个人使用、Windows Chrome | Q15已确认开发者模式加载解压目录 |

## 记录方式

术语写入 `CONTEXT.md`，已作出且具有实质取舍的架构决策再记录 ADR；未作出的选择只在本设计树标记，不伪装成已确认结论。

## 由当前决策得到的浏览器流程

1. 首次打开设置，粘贴现有面板的 CLASH 订阅地址。
2. 获取订阅并检查其格式和节点协议。只有兼容节点可以被选中；解析成功不等于节点能连接。
3. 用户手动选择节点并连接，应用 Smart 分流与对应代理认证配置。
4. 根据实际配置结果显示状态；延迟结果独立显示，不以“已发送连接命令”冒充已连通。
5. 应代理的请求不设置自动直连兜底；直连目标继续访问。
6. Chrome 重启恢复此前状态。每日更新订阅，更新失败保留有效缓存并提示。

订阅删除当前节点时提示手动重选并维持应代理请求不直连。同一节点凭据轮换自动应用。主动断开释放本插件代理设置；其他扩展占用控制权时只提示，不禁用对方。延迟测量方式和服务端同地址导出方式尚待确认。

## 已记录的架构决策

- `docs/adr/0001-extension-only.md`：仅安装 Chrome 扩展；服务器接入方案独立待决。
- `docs/adr/0002-https-clash.md`：浏览器使用标准 HTTPS 代理节点，首版读取 CLASH 订阅。
- `docs/adr/0003-existing-panel-subscription.md`：继续使用现有面板生成的 CLASH 地址，不另设专用订阅地址。
- `docs/adr/0004-proxy-failure.md`：应代理的请求失败时不自动降级为直连。

Q18架构细节见 `docs/user-accounting-design.md`，其中新端口和进程只是拟议范围，未实施。

## 官方能力依据

2026-09-27 通过 Playwright 只读访问 Chromium 官方 GitHub 镜像。Chrome 开发者文档站和 googlesource 访问超时，未将其页面当作本轮已读取证据。

- [Chrome proxy API schema](https://github.com/chromium/chromium/blob/main/extensions/common/api/proxy.json)：scheme 枚举包括 http、https、quic、socks4、socks5；不包含 Xray 节点协议。quic 仅存在于枚举，不据此承诺首版支持。
- [Chromium 代理实现说明](https://github.com/chromium/chromium/blob/main/net/docs/proxy.md)：HTTPS 代理是 HTTP proxy over TLS，可用 PAC 的 `HTTPS host:port` 配置；SOCKS5 不支持代理认证。
- [API 能力约束](https://github.com/chromium/chromium/blob/main/extensions/common/api/_api_features.json) 与 [manifest 能力约束](https://github.com/chromium/chromium/blob/main/extensions/common/api/_manifest_features.json)：原始 sockets 能力依赖 Chrome Apps 的 platform_app 范围或特定 allowlist，不能作为普通扩展的通用能力。

与服务器版本对应的3x-ui源码：

对应版本v3.8.5已核实提交为 `7ef22f94c950ff09f0870e2295fa65ad5968742c`。

- [v3.8.5 Clash生成器](https://github.com/MHSanaei/3x-ui/blob/v3.8.5/internal/sub/clash_service.go)：HTTP/SOCKS入站未纳入buildProxy；内联自定义YAML的非rules键覆盖已有值。
- [v3.8.5外部节点转换](https://github.com/MHSanaei/3x-ui/blob/v3.8.5/internal/sub/clash_external.go)：外部节点也没有标准HTTP/HTTPS支持分支。
- [v3.8.5订阅路由](https://github.com/MHSanaei/3x-ui/blob/v3.8.5/internal/sub/controller.go)：正常Clash路径使用legacy=false；raw view仅影响返回形式。
- [v3.8.5远程规则解析](https://github.com/MHSanaei/3x-ui/blob/v3.8.5/internal/sub/remote_routing.go)：远程内容的大小限制不能套用于当前内联规则。
- [v3.8.5订阅服务初始化](https://github.com/MHSanaei/3x-ui/blob/v3.8.5/internal/sub/sub.go)：初始化时读取Clash规则配置。
- [Mihomo proxy-providers](https://wiki.metacubex.one/config/proxy-providers/)：支持 `type: inline` 和 `payload` 节点列表。
- [Mihomo HTTP代理节点](https://wiki.metacubex.one/config/proxies/http/)：`type: http` 配合 `tls: true` 表达标准HTTPS代理。
