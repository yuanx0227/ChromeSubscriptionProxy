# 代理认证缓存与节点身份隔离

Chromium源码显示，代理认证缓存键与代理协议、host、port、认证目标和realm有关，用户名和密码是缓存值。网络栈可使用已缓存的有效凭据预认证，不必再次触发扩展的onAuthRequired。

因此，在同一个HTTPS代理地址上配置多个仍然有效的账户，仅修改扩展在onAuthRequired里返回的凭据，不能保证下一次连接已切换到新选中的身份。这是源码支持的机制风险，本轮未运行复现，不断言每次必现。

推荐为每个原节点身份分配稳定独立的HTTPS代理端口；同一个桥接进程维护多个入站，每个入站只接受该节点的独立凭据，并固定映射到对应原VLESS身份。用户名、密码和端口共同限制入口，端口不静默移交给其他身份。

当前6个原节点身份对应的拟议端口为18443–18448，均使用bwh.yxzyl.cn和同一域名证书。订阅携带端口，用户不手工管理它们。仅开放实际分配的端口；新增节点后由映射服务分配并同步所需端口规则。

固定单端口也可以通过每个节点独立DNS/TLS代理主机名隔离认证缓存，但这需要额外DNS与证书配置，当前未选择或实施。

源码依据：

- [认证缓存键](https://github.com/chromium/chromium/blob/main/net/http/http_auth_cache.h)
- [缓存凭据预认证](https://github.com/chromium/chromium/blob/main/net/http/http_auth_controller.cc)
- [onAuthRequired事件](https://github.com/chromium/chromium/blob/main/extensions/common/api/web_request.json)

没有找到普通扩展可用的单代理/单realm认证缓存清理API。handlerBehaviorChanged针对资源缓存；通过清cookies间接清认证缓存会影响浏览会话和连接，不作为常规节点切换方案。
