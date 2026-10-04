// QuickJS 逻辑插件宿主（v2.6）。
// 关键设计：逻辑插件为「同步纯函数」。注册由一段 JS 引导脚本完成（把 compute/buildRequest/
// parseResponse 挂到全局注册表），Rust 在被调用时按 id 从全局注册表取出函数同步调用；
// 所有异步数据（行情/HTTP/KV/信号）由 Rust 在调用前准备好并以 JSON 注入。
// 每个启用插件独立 runtime/context，限制内存 16MB、栈 256KB，并可由 kill 标志强制中断。
use rquickjs::{
    Array, AsyncContext, AsyncRuntime, Ctx, Function, IntoJs, Object, Value as JsValue,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 注入到每个逻辑插件的引导脚本：提供同步注册 API 与全局注册表。
const BOOT_JS: &str = r#"
var __indicators = {};
var __datasources = {};
function registerIndicator(spec) {
  if (!spec || !spec.id || typeof spec.compute !== 'function')
    throw new Error('registerIndicator 需要 {id, compute}');
  __indicators[spec.id] = spec.compute;
  return spec.id;
}
function registerDataSource(spec) {
  if (!spec || !spec.id || typeof spec.buildRequest !== 'function' || typeof spec.parseResponse !== 'function')
    throw new Error('registerDataSource 需要 {id, buildRequest, parseResponse}');
  __datasources[spec.id] = spec;
  return spec.id;
}
"#;

const MEM_LIMIT: usize = 16 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;

pub struct PluginEngine {
    rt: AsyncRuntime,
    ctx: AsyncContext,
    kill: Arc<AtomicBool>,
}

impl PluginEngine {
    pub async fn start(main_src: String) -> Result<Self, String> {
        let rt = AsyncRuntime::new().map_err(|e| format!("创建 JS 运行时失败: {e}"))?;
        rt.set_max_stack_size(STACK_LIMIT).await;
        rt.set_memory_limit(MEM_LIMIT).await;

        let kill = Arc::new(AtomicBool::new(false));
        {
            let k = kill.clone();
            rt.set_interrupt_handler(Some(Box::new(move || k.load(Ordering::Relaxed))))
                .await;
        }
        let ctx = AsyncContext::full(&rt).await.map_err(|e| format!("创建上下文失败: {e}"))?;

        ctx.with(|ctx| -> rquickjs::Result<()> {
            // 先注入注册 API，再执行插件 main.js。
            ctx.eval::<(), _>(BOOT_JS)?;
            ctx.eval::<(), _>(main_src)?;
            Ok(())
        })
        .await
        .map_err(|e| format!("插件 main.js 执行失败: {e}"))?;

        Ok(Self { rt, ctx, kill })
    }

    /// 调用自定义指标 compute(ctx)，ctx 为 Rust 注入的 {code,kline}。
    pub async fn compute(&self, indicator_id: &str, input: &Value) -> Result<Value, String> {
        let id = indicator_id.to_string();
        let input = input.clone();
        self.ctx
            .with(move |ctx| -> Result<Value, String> {
                let f = global_fn(&ctx, "__indicators", &id)?;
                let arg = json_to_js(&ctx, &input).map_err(|e| format!("参数转换失败: {e}"))?;
                let res: JsValue = f.call((arg,)).map_err(|e| format!("compute 执行失败: {e}"))?;
                js_to_json(&res).map_err(|e| format!("结果转换失败: {e}"))
            })
            .await
    }

    /// 数据源：buildRequest(params) -> {url,method,body}。
    pub async fn build_request(&self, ds_id: &str, params: &Value) -> Result<Value, String> {
        self.call_ds_fn(ds_id, "buildRequest", params).await
    }

    /// 数据源：parseResponse({status,body}) -> 数据。
    pub async fn parse_response(&self, ds_id: &str, resp: &Value) -> Result<Value, String> {
        self.call_ds_fn(ds_id, "parseResponse", resp).await
    }

    async fn call_ds_fn(&self, ds_id: &str, fn_name: &str, arg: &Value) -> Result<Value, String> {
        let id = ds_id.to_string();
        let fn_name = fn_name.to_string();
        let arg = arg.clone();
        self.ctx
            .with(move |ctx| -> Result<Value, String> {
                let g = ctx.globals();
                let dss: Object = g
                    .get("__datasources")
                    .map_err(|e| format!("读取数据源注册表失败: {e}"))?;
                let holder: Object = dss
                    .get(id.as_str())
                    .map_err(|_| format!("数据源 {id} 未注册"))?;
                let f: Function = holder
                    .get(fn_name.as_str())
                    .map_err(|_| format!("数据源缺少 {fn_name}"))?;
                let jsarg = json_to_js(&ctx, &arg).map_err(|e| format!("参数转换失败: {e}"))?;
                let res: JsValue = f.call((jsarg,)).map_err(|e| format!("{fn_name} 执行失败: {e}"))?;
                js_to_json(&res).map_err(|e| format!("结果转换失败: {e}"))
            })
            .await
    }

    /// 停用/卸载：置中断标志并回收。
    pub async fn shutdown(self) {
        self.kill.store(true, Ordering::Relaxed);
        let _ = self.rt.idle().await;
    }
}

/// 从全局注册表对象（__indicators）按 id 取出函数。
fn global_fn<'js>(ctx: &Ctx<'js>, registry: &str, id: &str) -> Result<Function<'js>, String> {
    let g = ctx.globals();
    let reg: Object<'js> = g
        .get(registry)
        .map_err(|e| format!("读取注册表失败: {e}"))?;
    reg.get(id).map_err(|_| format!("{id} 未注册"))
}

// ===== JSON ↔ QuickJS Value（同步）=====

fn json_to_js<'js>(ctx: &Ctx<'js>, v: &Value) -> rquickjs::Result<JsValue<'js>> {
    match v {
        Value::Null => Ok(JsValue::new_null(ctx.clone())),
        Value::Bool(b) => Ok(b.into_js(ctx)?),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into_js(ctx)?)
            } else if let Some(f) = n.as_f64() {
                Ok(f.into_js(ctx)?)
            } else {
                Ok(JsValue::new_undefined(ctx.clone()))
            }
        }
        Value::String(s) => Ok(s.as_str().into_js(ctx)?),
        Value::Array(arr) => {
            let a = Array::new(ctx.clone())?;
            for (i, item) in arr.iter().enumerate() {
                a.set(i, json_to_js(ctx, item)?)?;
            }
            Ok(a.into_js(ctx)?)
        }
        Value::Object(map) => {
            let o = Object::new(ctx.clone())?;
            for (k, val) in map {
                o.set(k.as_str(), json_to_js(ctx, val)?)?;
            }
            Ok(o.into_js(ctx)?)
        }
    }
}

fn js_to_json(v: &JsValue<'_>) -> rquickjs::Result<Value> {
    if v.is_null() || v.is_undefined() {
        Ok(Value::Null)
    } else if let Some(b) = v.as_bool() {
        Ok(json!(b))
    } else if let Some(i) = v.as_int() {
        Ok(json!(i))
    } else if let Some(f) = v.as_float() {
        Ok(json!(f))
    } else if let Some(s) = v.as_string() {
        Ok(json!(s.to_string()?))
    } else if let Some(a) = v.as_array() {
        let mut out = Vec::with_capacity(a.len());
        for item in a.iter::<JsValue>() {
            out.push(js_to_json(&item?)?);
        }
        Ok(Value::Array(out))
    } else if let Some(o) = v.as_object() {
        let mut map = serde_json::Map::new();
        for kv in o.props::<String, JsValue>() {
            let (k, val) = kv?;
            map.insert(k, js_to_json(&val)?);
        }
        Ok(Value::Object(map))
    } else {
        Ok(Value::Null)
    }
}
