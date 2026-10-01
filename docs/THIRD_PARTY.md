# 依赖和参考资料

本项目未复制 iGuge 的产品代码，`reference/` 保存的是用户提供的 CRX、解包和既有分析，仅供研究，不进入构建产物。

| 内容 | 来源 | 用途 |
|---|---|---|
| yaml | npm `yaml` 2.8.1，ISC | 扩展解析 CLASH YAML；许可证随扩展产物提供 |
| esbuild | npm，MIT | 开发时打包，不在浏览器中执行 |
| Playwright | npm，Apache-2.0 | 隔离浏览器的必要加载检查，不随扩展打包 |
| PyYAML | 6.0.3，MIT | 服务器读写 YAML |
| 有序分流规则 | [Shadowrocket-ADBlock-Rules-Forever](https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever)，CC BY-SA 4.0 | Moshel 与 Johnshall 的 sr_cnip.conf，Rule 部分转为有序 JSON；转换列表继续 CC BY-SA 4.0 |
| 国内地址 | [china-operator-ip](https://github.com/gaoyifan/china-operator-ip)，MIT | china.txt / china6.txt，按网络合并后打包 |

规则快照日期、原始 URL、作者、许可与转换说明存于 `extension/src/routing-data.json` 的 metadata；上游许可保留在 `docs/licenses/` 并随扩展提供。CC BY-SA 4.0 适用于转换后的规则列表，不扩展到本项目独立程序代码；国内 IP 数据独立采用 MIT。此前版本采用的 dnsmasq-china-list 已从 0.3.0 运行规则中移除，其 WTFPL 文件仅作为历史依赖记录保留。

自动更新只下载声明式数据，不下载或执行代码。规则按源顺序匹配；GEOIP 的 IPv4 用有序区间二分匹配，IPv6 按有效前缀匹配。脚本超过 1 MiB 时拒绝应用并保留既有版本。同步机制见 `RULES-UPDATE.md`，线上部署证据见 `RULES-DEPLOYMENT-RESULT.md`。
