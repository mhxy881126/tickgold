# Level-2 数据源插件试点（v2.32）

> 状态：**试点（beta）**。TickGold 自身不内置、不分发任何 Level-2 行情数据；
> 用户自备**合规数据商账号与 API Key**，数据口径与使用合规责任由用户与数据商的协议约定。
> 免费源依旧可用：未安装 / 未启用 / 未配置 Key / 请求失败时，盘口卡片自动安全降级回免费五档。

## 一、它解决什么

免费行情接口只提供五档买卖盘。部分持牌数据商提供十档（或更多）逐笔 / 深度盘口。
v2.32 在既有插件沙箱之上新增「Level-2 数据源」扩展点，让一个**只描述请求、只解析响应**的
QuickJS 插件把第三方深度盘口接入盘口卡片，而不破坏任何安全边界。

## 二、安全边界（不可放宽的红线）

延续 v2.6 插件设计，Level-2 插件**不是**放开网络权限的特殊插件：

1. 插件 JS 运行在受限 QuickJS 沙箱：**不能联网、不能读文件、不能访问券商交易能力**，
   单实例 16MB 内存 / 256KB 栈，可被强制中断。
2. JS 只产出**请求描述** `{url, method, body, headers}`，由 Rust 宿主校验
   权限（`level2:read` + HTTP 来源 / 路径白名单，拦截内网 / localhost）后**代为发起**。
3. **API Key 永不进入 JS**：Key 保存在操作系统凭据箱（keyring）；
   宿主在代发请求时把 Key 注入 `Authorization` 头。插件 `buildBookRequest` 返回的
   `headers` 里即使写了 `Authorization` 也会被丢弃，防止插件自填 / 窃取。
4. 解析结果必须是普通 `{asks:[...], bids:[...]}`，经 Rust 校验、限档（渲染上限 50 档）、
   重算委比 / 委差后才进入 UI；插件无法直接写盘口以外的任何状态。
5. 插件产生的任何交易相关信号仍走既有 pending + 人工确认流程，Level-2 通道**不开放实盘下单**。

## 三、插件清单与注册

`plugin.json` 需声明能力域与数据商域名白名单：

```json
{
  "id": "com.example.mylevel2",
  "name": "我的 Level-2 源",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": [
    "level2:read",
    "https://api.my-level2-vendor.com/*"
  ],
  "main": "main.js"
}
```

`main.js` 内调用引导注入的 `registerLevel2`：

```js
registerLevel2({
  id: "l2",                       // provider id；一个插件可注册多个
  buildBookRequest(params) {      // 纯函数：{ code, provider } -> 请求描述
    return {
      url: `https://api.my-level2-vendor.com/depth?code=${params.code}`,
      method: "GET",
      headers: { Accept: "application/json" }  // 不要、也无法放 Authorization
    };
  },
  parseBookResponse(resp) {       // 纯函数：{ status, body } -> { asks, bids }
    const data = JSON.parse(resp.body).data;
    return {
      asks: data.sells.map(r => ({ price: r.price, vol: r.volume })),
      bids: data.buys.map(r => ({ price: r.price, vol: r.volume }))
    };
  }
});
```

- `vol` 单位统一为**手**；若数据商返回股，需要在 `parseBookResponse` 内 ÷100。
- 档位行支持 `{price, vol}` 对象或 `[price, vol]` 数组两种形态。
- 宿主会过滤 `price<=0` 或非法行；`asks` / `bids` 任一为空即视为本次失败并降级。
- 请求失败、超时、Key 缺失、解析抛错都**不会弹窗 / 不会中断盯盘**，盘口静默回退免费五档。

## 四、端到端调用链

```
盘口卡片 ensure("o")
  └─ get_orderbook(code)               # 免费五档打底
  └─ plugin_l2_providers()             # 发现：启用 + level2:read + 已注册 provider
  └─ plugin_rpc(id, "level2.book", {code, provider})
        Rust:
          1) 校验 level2:read、code 非空
          2) 取免费 OrderBook 作基底
          3) JS buildBookRequest -> permission::check_http
          4) keyring 取 Key（缺失则报错降级），ds_http_extra 注入 Authorization 代发
          5) JS parseBookResponse -> merge_book（校验/限档/重算委比委差）
  └─ 成功：渲染 N 档盘口 + 来源标注（含「用户自带 Key」）；失败：保留免费五档
```

## 五、用户侧使用

1. 设置 → 插件生态：安装或启用 Level-2 插件（未签名插件需先开「开发者模式」）。
2. 在声明了 `level2:read` 的插件卡片上粘贴数据商 **API Key** → 保存。
   Key 只写入系统凭据箱，界面仅显示「已配置 / 未配置」，不回显明文。
3. 打开盘口卡片：若该插件已配置 Key，会自动尝试升级为 Level-2 深度，
   并在盘口下方标注来源、档数与合规提示。
4. 停用 / 卸载插件或清除 Key 后立即回到免费五档；清除 Key 不影响其他插件。

## 六、开发骨架

随包内置只读模板：`src-tauri/resources/plugins/l2-template/`
（`plugin.json` + `main.js`，含沪深北市场前缀推断、字段映射与安全注释）。
复制该目录、改 `id` / 域名白名单 / 字段映射后，通过「本地安装」载入即可联调。
