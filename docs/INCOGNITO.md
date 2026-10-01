# 无痕模式支持 · 0.3.2

用户在侧边对话明确要求修改并验证。本次仅将扩展的 `incognito` 从 `not_allowed` 改为 `spanning`，允许用户在 Chrome 扩展详情中授权无痕访问；保留已有后台代理设置和认证实现。

普通和无痕窗口共用订阅、所选线路、分流规则及连接开关，不提供无痕窗口单独选线。Chrome 在没有独立无痕代理覆盖时会继承本扩展的 regular PAC；这次已实际验证该继承。其他扩展或策略另行控制无痕代理的情况不在本轮测试范围内。

## 更新方式

1. 在 `chrome://extensions` 点击晴空的重新加载，确认版本 0.3.2。
2. 打开“详情”，开启“在无痕模式下启用”。Chrome 如果提示重启后生效，按提示重启。
3. 使用现有订阅和线路连接，然后打开无痕窗口。无需移除插件或重新填写订阅。

## 验证

用 Playwright 驱动本机 Chrome 的独立临时 profile，在扩展管理页实际打开无痕开关，再创建真正的 off-the-record context。测试节点为本机带 Basic 认证的 TLS 代理，测试域名为 `.test`；没有连接生产代理、修改服务器或读取日常 Chrome profile。

通过项目 `checks/incognito.mjs` 确认：

- 普通窗口成功通过 TLS 代理请求测试页面。
- 无痕页面触发独立的 407，扩展自动提交凭据并取得页面，无需人工输入。
- 无痕代理配置为继承的 PAC（`incognitoSpecific=false`）。
- 无痕访问本机地址走直连，不进入代理。
- 从扩展断开后，无痕代理控制权同时释放。

本机测试证书为临时自签证书，仅在隔离测试浏览器通过启动参数忽略证书错误。产品代码和真实代理的证书校验未改变。此次验证覆盖无痕代理认证、PAC 继承与本机直连，不作为所有网络环境或此前其他认证弹窗问题均已解决的证明。

测试准备：本机 Python 安装 cryptography 后，执行 `python checks/incognito-cert.py` 生成 `work/incognito-tls` 中临时证书；执行 `node checks/incognito.mjs`。结果保存在 `work/incognito-result.json`，没有真实账号。
