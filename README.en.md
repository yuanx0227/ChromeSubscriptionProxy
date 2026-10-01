<p align="center">
  <img src="extension/public/icons/icon128.png" width="64" alt="Qingkong">
</p>

<h1 align="center">Qingkong · 晴空</h1>

<p align="center">Chrome subscription proxy · Node selection · Smart routing</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

Import your CLASH subscription, choose a node and connect in Chrome. Manage website rules, receive automatic updates and measure the selected node's latency.

<table>
  <tr>
    <th width="70%">Settings</th>
    <th width="30%">Popup</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/settings-readme.png" width="640" alt="Qingkong settings"></td>
    <td><img src="docs/screenshots/popup-v3.png" width="300" alt="Qingkong popup"></td>
  </tr>
</table>

## Features

| Feature | What it does |
|---|---|
| Subscriptions | Import CLASH, update daily and keep the last configuration on failure |
| Smart routing | Default rules, IPv4 / IPv6 and custom proxy/direct domains |
| Connection control | Select a node, connect/disconnect and restore after restart |
| Network checks | Measure the current node's latency and recheck after failures |

## Quick start

For **Chrome 120+ on Windows**. The extension directory is `dist/extension`; source users should [build it locally](#local-build) first.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `dist/extension`.
3. Open Qingkong settings, enter your HTTPS CLASH subscription URL and save/refresh it.
4. Select a node in the popup and connect.

> The subscription must provide authenticated HTTPS proxy nodes. VLESS / REALITY-only subscriptions need the companion [server bridge](docs/DEPLOYMENT.md).

## Everyday use

- **Check latency:** run the latency check for the selected node.
- **Update the extension:** replace the extension files, then click **Reload** at `chrome://extensions`.
- **Incognito:** enable **Allow in incognito** in extension details.

Subscriptions and credentials stay on your device. Routing applies to Chrome proxy requests; requests assigned to a proxy do not switch to direct connections on failure.

## Local build

Use **Node.js 22+** and run from the project root:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Output: `dist/extension`.

<details>
<summary>Packaging and routing data maintenance</summary>

```powershell
npm run pack                     # Generate CRX3 in releases/
python scripts/update-routing.py # Update bundled rules (Python 3.9+)
```

Windows Chrome restricts CRX installation outside the Web Store; loading the unpacked directory is recommended. Keep the signing key in `signing/` and reuse it for subsequent packages.

</details>

[Server deployment](docs/DEPLOYMENT.md) · [Implementation](docs/IMPLEMENTATION.md) · [Third-party licenses](docs/THIRD_PARTY.md) — detailed documents are in Chinese.
