# 晴空 · Chrome 订阅代理

[English](README.en.md)

Windows Chrome 代理扩展。导入 CLASH 订阅即可选线连接，无需插件登录或本机代理核心。

## 功能

- 手动选线、一键连接与断开。
- Smart 分流，自定义代理和直连域名。
- 订阅与规则每日更新，更新失败保留缓存。
- 延迟检测、异常自动复查、重启恢复连接。

## 安装

需要 **Chrome 120+、Node.js 22+**。下载源码，在项目根目录执行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/extension`。

## 使用

1. 打开扩展设置，粘贴自己的 HTTPS CLASH 订阅地址，保存并更新。
2. 选择浏览器节点，点击「连接」。
3. 点击「检测延迟」检查连通性；更新扩展后，在扩展管理页点击「重新加载」。

订阅需包含带账号密码的 HTTPS 代理节点（`type: http`、`tls: true`）。只有 VLESS 节点时，先配置[服务器桥接](docs/DEPLOYMENT.md)。

订阅和凭据保存在本机。应代理请求失败时不自动直连；代理范围仅限浏览器。使用无痕窗口需在扩展详情中开启「在无痕模式下启用」。

## 开发

```powershell
npm run pack                    # 生成 CRX3 到 releases/
python scripts/update-routing.py # 更新内置规则（Python 3.9+）
```

Windows Chrome 安装非商店 CRX 可能受限，建议加载目录版。签名私钥位于 `signing/`，请妥善保管。

[服务器部署](docs/DEPLOYMENT.md) · [实现说明](docs/IMPLEMENTATION.md) · [第三方许可](docs/THIRD_PARTY.md)
