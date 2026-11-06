# 手搓CPE 网页版

> 本仓库为**代发**，原作者是酷安「大砖头没救了」，由 [bingshuang2014](https://github.com/bingshuang2014) 发布；
> 仓库地址 <https://github.com/bingshuang2014/cep-master>，项目说明与源码安全审查见[仓库根目录 README](../README.md)。

```sh
node server.mjs
```

- 默认端口 `8090`（`PORT=xxxx node server.mjs` 可改）
- 手机打开 `http://127.0.0.1:8090`
- 同一 WiFi 的电脑打开 `http://<手机 IP>:8090`

服务端代理 `/ubus` 到路由器，解决 OpenWrt 的 CORS；出口优先绑定 WiFi 网卡。
5G 通信壳页直接 iframe `http://192.168.66.1:9527`，需要模组在线；手机开移动数据时
可能走 4G，建议用 App 版。
