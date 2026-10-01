# 0.2 界面改版

设置页将主要操作分为“我的订阅”和“连接线路”，同一页可以完成导入、选线、连接，不再必须切到弹窗操作。网站规则默认折叠，隐私与分流数据移入页脚说明。

弹窗突出当前状态、所选线路、连接按钮；未导入时显示“添加订阅，开始使用”，而不是可点击但不可用的连接按钮。地址默认隐藏，可手动显示。保存规则和更新订阅后显示反馈。

Logo 通过 imagegen 技能的 `image_gen.py` 生成，模型为服务端提供的 `gpt-image-2.5-sunburst`。API 凭据从本机 auth.json 读取，base_url 从 config.toml 读取；不保存到项目。原图位于 `output/imagegen/qingkong-logo.png`，Chrome 图标位于 `extension/public/icons/`。

生成提示词：

> Use case: logo-brand. Create one polished app icon for Qingkong, a personal Chrome proxy extension named Clear Sky. An original bold white abstract cloud and flowing open-sky path, with a small sun implied by negative space. Simple memorable geometric silhouette, confident thick forms legible at 16 pixels. Centered symbol occupying 70 percent of the canvas on a solid rich cobalt blue full-bleed square background. Flat vector-like graphic, exquisitely balanced, clean edges, professional software brand. No lettering, no text, no mockup, no shadows, no border, no extra objects. Output a single square logo, not a presentation sheet.

更新方式：在 `chrome://extensions` 找到通过项目 `dist/extension` 加载的晴空，点击重新加载，再重新打开设置页/弹窗。同路径重新加载保留现有订阅和规则，不需要移除插件。

本轮只更新本地界面、图标与发行包，不修改已部署服务器。

生成结果带透明通道，已保留原图，并将原始标志合成到品牌蓝底，得到 `output/imagegen/qingkong-logo-app.png`，再缩放为 16/32/48/128/256 像素图标。未使用代码重画标志。

已通过构建和必要的 Playwright 页面检查：空状态、地址显隐、订阅导入、设置页选线连接、规则展开与保存、390px 窄屏无横向溢出、弹窗图标及断开。使用隔离 Chrome 和合成订阅，没有改变用户正在使用的代理设置。页面预览在 `docs/screenshots/*-v2*.png`。
