# 0.3.0 自动更新分流规则

状态：2026-09-27 用户明确授权“部署”后，新增规则服务器任务与 Caddy 路由已部署并通过必要验证；原桥接服务未改动、未重启。具体证据见 [RULES-DEPLOYMENT-RESULT.md](RULES-DEPLOYMENT-RESULT.md)。本文末尾保留实际采用的部署清单。

## 数据与优先级

采用 [Johnshall/Shadowrocket-ADBlock-Rules-Forever](https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever) release 分支的 [sr_cnip.conf](https://raw.githubusercontent.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever/release/sr_cnip.conf)。当前内置转换结果 392 条规则，上游标注构建时间 UTC 2026-09-26 23:04:28。

保留源文件 Rule 部分顺序，支持 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR（IPv4 或 IPv6）、IP-CIDR6、GEOIP,CN,DIRECT 和末尾 FINAL,PROXY。策略大小写不敏感，行尾注释移除，CIDR 规范化；未知类型/策略/参数直接拒绝整次更新，避免悄悄漏规则。

每次 PAC 判定顺序为：本机/私网与保留域名 → 用户自定义规则（更具体域名优先）→ 源规则原顺序。订阅来源域名与本项目规则来源域名固定直连；检测域名保留代理。旧版 11 万条国内域名白名单不再插入这份规则前后，避免改变源规则语义。

GEOIP 的中国大陆 IPv4/IPv6 数据独立来自 gaoyifan/china-operator-ip 的 china.txt、china6.txt，分别 6,207 和 3,415 段。它们与 sr_cnip 同次获取、校验后一起发布；任何一份失败则保留上一完整版本。

PAC 无法获知浏览器最终使用哪一个 DNS 地址，多个解析结果会分别按有序规则判定，只有全部结果判定为直连时才直连，混合结果走代理。`no-resolve` 仅匹配 URL 本身为 IP 的目标，不用域名解析结果命中该条 CIDR。局域网保留策略仍优先。

不导入 General、DNS、URL Rewrite、MITM，不启用广告过滤，也不执行远端代码。规则是严格校验的声明式 JSON，由扩展自己的固定代码生成 PAC。未知目标及代理失败没有 DIRECT 兜底。

## 更新与失败处理

- 服务端：独立 oneshot + systemd timer，每日 UTC 00:15（北京时间 08:15）加最多 10 分钟随机延迟，避开上游实际 UTC 23:00 构建计划。首次部署立即执行一次。系统关机错过日程由 Persistent 补跑。
- 插件：独立每日 alarm；未更新超过一天时，在 worker 启动后安排一次补更新。规则折叠区提供手动更新，保持 0.2.1 的简洁主界面和字号。
- 首次可使用随扩展提供的规则；下载/解析失败保留上次规则。候选数据和生成的 PAC 全部校验后才应用并缓存；已启用时若候选设置应用/保存失败，尝试恢复之前的 PAC。
- 规则缓存与用户订阅/自定义规则分开保存，不重置选线或自定义规则。代理控制冲突时缓存有效新规则，等待用户解决控制权冲突后按新规则连接。
- 服务端输出文件原子替换；插件不接受重定向、非 JSON、超过大小预算、未知 schema 或任意脚本。

上游 README 的“北京时间 08:00”与 workflow `0 23 * * *`（北京时间 07:00）不一致。我们独立选择 08:15，不依赖其文字保证。每日生成不代表规则每天经过实测，也未采用 README 已指出数据陈旧的 top500 变体。

## 许可

Moshel 与 Johnshall 的原规则，以及本项目转换后的 `rules` 列表，适用 **CC BY-SA 4.0**，保留作者、项目、原始 URL、许可链接和修改说明。此许可范围为规则数据，独立编写的插件/转换器代码不因数据使用被标成同一许可。

独立国内 IP 数据来自 Yifan Gao / china-operator-ip，MIT 许可。生成 JSON 的 metadata 分开声明两者来源及许可。扩展内的“规则来源”页面、许可证文件、随包 JSON 和文档均保留归属。源码链接公开可用，源配置里的指令不作为开发指令。

## 已完成的必要检查

- 6 项 Node 检查：有序规则、精确域名与后缀/关键词、IPv4/IPv6、no-resolve、私网/保留地址和自定义优先级；恶意/未知结构和过大响应拒绝。
- 3 项 Python 检查：只转换 Rule 段、源顺序和策略规范化；下载/原子发布失败不覆盖已有文件；真实内置快照包含独立 GeoIP 与 FINAL,PROXY。
- 隔离 Chrome：实际 PAC 应用、24 小时 alarm、成功更新；模拟 HTTP 503 和格式错误时缓存/PAC保持原值，自定义规则保留。未触及用户日常 Chrome 或真实代理账号。
- UI 保留 0.2.1 简化布局，新增信息仅在网站规则展开后显示。代理认证弹窗的独立问题不在本轮验证结论内。

## 已执行的线上变更（可单独撤回）

1. 新建 `/opt/qingkong-rules`（root:root，0755），安装 `server/routing_update.py` 为 root:root 0644。使用服务器现有 Python 3.9，无新增 Python 依赖。
2. 安装 `server/qingkong-rules.service` 与 `.timer` 到 `/etc/systemd/system/`。以现有 chrome-proxy 用户运行，输出目录 `/var/lib/qingkong-rules` 由 StateDirectory 创建为 0755，数据文件 0644，供 Caddy 只读。
3. 先手动启动 oneshot，确认抓取和生成成功；源站失败时不要切换任何代理配置，内置规则继续可用。
4. 在现有 bwh.yxzyl.cn HTTPS site 内加入 `server/qingkong-rules.caddy` 的精确路径段，发布 `https://bwh.yxzyl.cn/qingkong/routing-v1.json`。校验 Caddy 配置后，通过该服务器已有的 USR1 方式重载。
5. 启用 timer。规则更新不调用 x-ui/Xray API，不改变订阅或端口，不重启原核心或桥接进程，不新增监听端口。
6. 最小线上验证：公开地址确为 JSON 且无凭据；插件手动更新及定时器启用成功；原订阅与代理仍正常。

撤回：禁用/停止规则 timer，移除本次精确 Caddy 路由并重载。插件更新失败继续使用最后缓存；如需回退规则语义，加载此前 0.2.1 产物。保留主桥接服务、面板和现有订阅。
