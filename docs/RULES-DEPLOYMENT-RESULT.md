# 0.3.0 规则服务部署记录

2026-09-27，用户明确授权“部署”。已执行 `RULES-UPDATE.md` 中新增规则服务的清单。

## 已上线

- `/opt/qingkong-rules/routing_update.py`：root 所有，普通服务用户可读；不依赖新的 Python 包。
- `qingkong-rules.service`：以现有 chrome-proxy 用户执行的 oneshot，成功运行后退出属于正常状态。本次 `Result=success`、`ExecMainStatus=0`。
- `qingkong-rules.timer`：已启用且 active，每日北京时间 08:15 加最多十分钟随机延迟，关机错过会补跑。部署时下次执行为 **2026-09-28 08:19:58 北京时间**。
- 输出 `/var/lib/qingkong-rules/routing-v1.json`，权限 0644，公开内容只有规则及来源许可元数据。
- Caddy 新增精确路由 [https://bwh.yxzyl.cn/qingkong/routing-v1.json](https://bwh.yxzyl.cn/qingkong/routing-v1.json)。配置校验通过，USR1 重载成功。没有新开端口或修改防火墙。

## 本次验证

| 项目 | 结果 |
|---|---|
| 首次服务器抓取和转换 | 成功，392 条有序规则、6,207 段 IPv4、3,415 段 IPv6 |
| 上游构建标注 | UTC 2026-09-26 23:04:28；抓取时间 UTC 2026-09-27 15:00:48 |
| 公开下载 | HTTP 200，application/json，no-cache；262,722 字节 |
| 声明式结构与许可 | 仅 schema/rules/ipv4/ipv6/metadata；保留 CC-BY-SA-4.0 署名、独立 IP 数据 MIT 来源和 FINAL,PROXY |
| Chrome 实际更新 | 隔离 Chrome 点击“更新规则”，真实下载公开地址、校验并缓存成功，无网络响应模拟 |
| 启用代理时更新 | 使用合成的本地验收节点让扩展处于启用状态，规则域名保留直连；实际 Chrome PAC 应用成功，266,948 字节 |
| 每日客户端更新 | routing-refresh alarm 存在，周期 1,440 分钟 |
| 现有六份订阅 | 每份仍返回原 VLESS 节点和其自身 HTTPS 节点各一个 |
| 现有代理请求 | 真实 HTTPS 代理请求返回 204，CONNECT 200，代理与目标 TLS 校验均成功 |
| 服务连续性 | 面板 PID 154285、Caddy PID 394905、桥接 supervisor PID 606909、原 Xray PID 607672、桥接核心 PID 607710 均与部署前相同 |

客户端实际获取时间 UTC 2026-09-27 15:02:38。该验证使用隔离 profile，结束后已释放其代理设置并清除测试扩展存储；用户日常 Chrome 配置没有被工具修改。

服务器每日 timer 的未来运行尚未等到；本次验证的是首次真实执行成功、计划配置正确及 timer 已启用。此前的下载/解析失败保留缓存逻辑已有定向检查，本次没有再次制造服务器故障。

## 使用

在 `chrome://extensions` 对目录版晴空点击“重新加载”，确认版本 0.3.0。可以展开“网站规则”点击“更新规则”立即获取，之后插件每天自动更新。现有订阅、自定义规则和选线保留。

这次部署不包含此前代理认证弹窗问题的修复，不把规则更新验证等同于认证问题已解决。
