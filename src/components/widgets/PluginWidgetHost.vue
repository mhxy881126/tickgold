<script setup lang="ts">
// 插件 UI 微件宿主（v2.6）。
// 安全：iframe 仅 sandbox="allow-scripts"（不给 allow-same-origin）→ 无父 DOM、无 Tauri IPC，
// 唯一通道 postMessage。父侧订阅行情并推送；iframe 内的 TickGold.* 调用经 RPC 回到 Rust，
// 由 host.rs 在权限范围内执行。iframe 填满网格单元，尺寸由卡内布局决定。
import {
  onBeforeUnmount,
  onMounted,
  ref,
  toRef,
  watch,
} from "vue";
import { useWidgetData } from "../../composables/useMarketContext";
import { pluginReadAsset, pluginRpc } from "../../plugin/api";

const props = defineProps<{
  pluginId: string;
  widgetId: string;
  bind?: string | null;
}>();

const d = useWidgetData(toRef(props, "bind"));
const frameRef = ref<HTMLIFrameElement | null>(null);
const srcdoc = ref("");
const ready = ref(false);

// 注入 iframe 的桥接脚本：提供 window.TickGold（RPC + 行情推送）。
const SHIM = `
(function(){
  var seq=0, pending={}, handlers={quote:[]};
  function send(o){ parent.postMessage(o,'*'); }
  function rpc(method,params){
    return new Promise(function(resolve,reject){
      var id=++seq; pending[id]={resolve:resolve,reject:reject};
      send({type:'rpc',id:id,method:method,params:params});
    });
  }
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||typeof d!=='object') return;
    if(d.type==='rpc-result'){
      var p=pending[d.id]; if(!p) return; delete pending[d.id];
      if(d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
    } else if(d.type==='init'){
      window.__code=d.code; window.__name=d.name;
    } else if(d.type==='update'){
      window.__quote=d.quote;
      handlers.quote.forEach(function(fn){ try{fn(d.quote);}catch(_){} });
    }
  });
  window.TickGold={
    quotes:{ get:function(code){ return rpc('quotes.get',{code:code}); } },
    kline:{
      get:function(code,period,count){ return rpc('kline.get',{code:code,period:period,count:count}); },
      minute:function(code){ return rpc('kline.minute',{code:code}); }
    },
    watchlist:{ list:function(){ return rpc('watchlist.list',{}); } },
    signal:{ create:function(payload){ return rpc('signal.create',payload); } },
    store:{
      get:function(key){ return rpc('store.get',{key:key}); },
      set:function(key,value){ return rpc('store.set',{key:key,value:value}); }
    },
    http:{ fetch:function(url,options){ return rpc('http.fetch',{url:url,options:options||{}}); } },
    computeIndicator:function(id,opts){
      return rpc('indicator.compute', Object.assign({indicator:id}, opts||{}));
    },
    fetchDataSource:function(id,params){
      return rpc('datasource.fetch',{datasource:id,params:params||{}});
    },
    log:{
      info:function(){ return rpc('log.info',{args:Array.prototype.slice.call(arguments)}); },
      warn:function(){ return rpc('log.warn',{args:Array.prototype.slice.call(arguments)}); },
      error:function(){ return rpc('log.error',{args:Array.prototype.slice.call(arguments)}); }
    },
    currentQuote:function(){ return window.__quote; },
    code:function(){ return window.__code; },
    onQuote:function(fn){ handlers.quote.push(fn); }
  };
  window.addEventListener('error',function(ev){ send({type:'error',message:String(ev.message)}); });
  send({type:'ready'});
})();
`;

onMounted(async () => {
  let ui = "";
  try {
    ui = await pluginReadAsset(props.pluginId, "ui.js");
  } catch (e) {
    ui = `document.body.textContent='ui.js 读取失败：${String(e)}';`;
  }
  const safe = ui.replace(/<\/script>/gi, "<\\/script>");
  srcdoc.value =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;" +
    "font-family:inherit;background:transparent;color:inherit;}#app{height:100%;}</style>" +
    '</head><body><div id="app"></div>' +
    "<script>" + SHIM + "<\/script>" +
    "<script>" + safe + "<\/script>" +
    "</body></html>";
});

function post(obj: unknown) {
  frameRef.value?.contentWindow?.postMessage(obj, "*");
}

function onMessage(ev: MessageEvent) {
  const w = frameRef.value;
  if (!w || ev.source !== w.contentWindow) return;
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "rpc") {
    pluginRpc(props.pluginId, data.method, data.params)
      .then((result) => post({ type: "rpc-result", id: data.id, result }))
      .catch((err) =>
        post({
          type: "rpc-result",
          id: data.id,
          error: String(err?.message ?? err),
        }),
      );
  } else if (data.type === "error") {
    console.warn(`[plugin:${props.pluginId}] ${data.message}`);
  }
}

function onLoad() {
  ready.value = true;
  post({ type: "init", code: d.code.value, name: d.name.value });
  post({ type: "update", quote: d.quote.value ?? null });
}

watch(
  () => d.quote.value,
  (q) => {
    if (ready.value) post({ type: "update", quote: q ?? null });
  },
  { deep: true },
);
watch(
  () => d.code.value,
  () => {
    if (ready.value)
      post({ type: "init", code: d.code.value, name: d.name.value });
  },
);

window.addEventListener("message", onMessage);
onBeforeUnmount(() => window.removeEventListener("message", onMessage));
</script>

<template>
  <iframe
    ref="frameRef"
    class="plugin-frame"
    sandbox="allow-scripts"
    :srcdoc="srcdoc"
    title="plugin-widget"
    @load="onLoad"
  ></iframe>
</template>

<style scoped>
.plugin-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: transparent;
}
</style>
