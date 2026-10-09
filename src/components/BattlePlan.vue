<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { renderMarkdown } from "../ai/markdown";
import {
  convertInstructionAlert,
  generatePlan,
  getLatestPlan,
  setPlanStatus,
  updateInstruction,
  updatePlanText,
  type PlanInfo,
  type PlanInstructionInfo,
} from "../ai/api";

const plan = ref<PlanInfo | null>(null);
const loading = ref(false);
const errMsg = ref("");
const toast = ref("");
const editingView = ref(false);
const viewDraft = ref("");
const editInstr = ref<number | null>(null);
const condDraft = ref("");
const actionDraft = ref("");

const tierMeta: Record<string, { label: string; color: string }> = {
  trigger: { label: "触发", color: "#ff5a6a" },
  candidate: { label: "候选", color: "#d4af37" },
  watch: { label: "观察", color: "#5aa0ff" },
};

const statusMeta: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "#8a93a6" },
  approved: { label: "已批准", color: "#3fcf8e" },
  archived: { label: "已归档", color: "#6a7488" },
};

const tiers = computed(() =>
  ["trigger", "candidate", "watch"].map((tier) => ({
    tier,
    items: plan.value?.instructions.filter((i) => i.tier === tier) ?? [],
  }))
);

const renderedView = computed(() =>
  plan.value ? renderMarkdown(plan.value.marketView) : ""
);

function showToast(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ""), 2600);
}

async function load() {
  try {
    plan.value = await getLatestPlan();
  } catch {
    plan.value = null;
  }
}

async function generate() {
  loading.value = true;
  errMsg.value = "";
  try {
    plan.value = await generatePlan();
  } catch (e) {
    errMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

function startEditView() {
  viewDraft.value = plan.value?.marketView ?? "";
  editingView.value = true;
}

async function saveView() {
  await updatePlanText(plan.value!.id, "marketView", viewDraft.value);
  editingView.value = false;
  await load();
}

function startEditInstr(i: PlanInstructionInfo) {
  editInstr.value = i.id;
  condDraft.value = i.condition;
  actionDraft.value = i.action;
}

async function saveInstr() {
  const id = editInstr.value as number;
  await updateInstruction(id, "condition", condDraft.value);
  await updateInstruction(id, "action", actionDraft.value);
  editInstr.value = null;
  await load();
}

async function toAlert(i: PlanInstructionInfo) {
  try {
    await convertInstructionAlert(i.id);
    showToast(`已转为预警：${i.name || i.code}`);
  } catch (e) {
    errMsg.value = String(e);
  }
}

async function setInstrStatus(i: PlanInstructionInfo, status: string) {
  await updateInstruction(i.id, "status", status);
  await load();
}

async function setStatus(status: string) {
  await setPlanStatus(plan.value!.id, status);
  await load();
}

onMounted(() => {
  void load().catch(() => {});
});
</script>

<template>
  <div class="bp">
    <template v-if="plan">
      <div class="bp-head">
        <div class="bp-title">
          {{ plan.title || `作战计划 · ${plan.planDate}` }}
          <span class="bp-status" :style="{ color: statusMeta[plan.status]?.color }">
            {{ statusMeta[plan.status]?.label }}
          </span>
        </div>
        <div class="bp-actions">
          <button
            v-if="plan.status === 'draft'"
            class="bp-mini bp-primary"
            @click="setStatus('approved')"
          >
            批准
          </button>
          <button
            v-if="plan.status !== 'archived'"
            class="bp-mini"
            @click="setStatus('archived')"
          >
            归档
          </button>
          <button class="bp-mini" :disabled="loading" @click="generate">
            {{ loading ? "生成中…" : "重新生成" }}
          </button>
        </div>
      </div>
      <div class="bp-sub">
        生效日 {{ plan.planDate }} · 基于 {{ plan.sourceReviewDate }} 复盘 · {{ plan.instructions.length }} 条指令
      </div>

      <div class="bp-view">
        <div class="bp-sec">
          市场观点
          <button class="bp-link" @click="startEditView">编辑</button>
        </div>
        <div v-if="!editingView" class="bp-md" v-html="renderedView"></div>
        <template v-else>
          <textarea v-model="viewDraft" class="bp-area" rows="5"></textarea>
          <div class="bp-row-actions">
            <button class="bp-mini bp-primary" @click="saveView">保存</button>
            <button class="bp-mini" @click="editingView = false">取消</button>
          </div>
        </template>
      </div>

      <div class="bp-cols">
        <div v-for="g in tiers" :key="g.tier" class="bp-col">
          <div class="bp-col-head" :style="{ color: tierMeta[g.tier]?.color }">
            {{ tierMeta[g.tier]?.label }}
            <i>{{ g.items.length }}</i>
          </div>
          <div class="bp-cards">
            <div
              v-for="i in g.items"
              :key="i.id"
              class="bp-card"
              :data-status="i.status"
            >
              <template v-if="editInstr !== i.id">
                <div class="bp-card-head">
                  <span class="bp-code">{{ i.code }}</span>
                  <span class="bp-name">{{ i.name }}</span>
                  <span v-if="i.theme" class="bp-theme">{{ i.theme }}</span>
                </div>
                <div v-if="i.condition" class="bp-line">
                  <b>条件</b><span>{{ i.condition }}</span>
                </div>
                <div v-if="i.action" class="bp-line">
                  <b>操作</b><span>{{ i.action }}</span>
                </div>
                <div v-if="i.positionHint" class="bp-line">
                  <b>仓位</b><span>{{ i.positionHint }}</span>
                </div>
                <div class="bp-card-foot">
                  <button class="bp-link" @click="startEditInstr(i)">编辑</button>
                  <button
                    v-if="i.status === 'open'"
                    class="bp-link"
                    @click="toAlert(i)"
                  >
                    转预警
                  </button>
                  <button
                    v-if="i.status === 'open'"
                    class="bp-link"
                    @click="setInstrStatus(i, 'done')"
                  >
                    完成
                  </button>
                  <button
                    v-if="i.status !== 'dropped'"
                    class="bp-link bp-drop"
                    @click="setInstrStatus(i, 'dropped')"
                  >
                    放弃
                  </button>
                  <button
                    v-if="i.status !== 'open'"
                    class="bp-link"
                    @click="setInstrStatus(i, 'open')"
                  >
                    重开
                  </button>
                </div>
              </template>
              <template v-else>
                <div class="bp-edit-label">触发条件</div>
                <textarea v-model="condDraft" class="bp-area" rows="2"></textarea>
                <div class="bp-edit-label">操作建议</div>
                <textarea v-model="actionDraft" class="bp-area" rows="2"></textarea>
                <div class="bp-row-actions">
                  <button class="bp-mini bp-primary" @click="saveInstr">保存</button>
                  <button class="bp-mini" @click="editInstr = null">取消</button>
                </div>
              </template>
            </div>
            <div v-if="g.items.length === 0" class="bp-col-empty">无</div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="bp-empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">暂无作战计划</div>
      <div class="empty-desc">作战计划由慢脑基于当日复盘生成，帮你规划次日交易策略。</div>

      <div class="empty-steps">
        <div class="step">
          <span class="step-num">1</span>
          <div class="step-body">
            <div class="step-title">确保 AI 模型已配置</div>
            <div class="step-sub">在设置中配置 DeepSeek / 其他大模型 API</div>
          </div>
        </div>
        <div class="step">
          <span class="step-num">2</span>
          <div class="step-body">
            <div class="step-title">有持仓或自选股</div>
            <div class="step-sub">计划会基于你的持仓和观察股生成</div>
          </div>
        </div>
        <div class="step">
          <span class="step-num">3</span>
          <div class="step-body">
            <div class="step-title">点击下方按钮生成</div>
            <div class="step-sub">生成约需 1-2 分钟，生成后可编辑批准</div>
          </div>
        </div>
      </div>

      <button class="bp-btn primary" :disabled="loading" @click="generate">
        {{ loading ? "生成中（约 1-2 分钟）…" : "✨ 生成次日作战计划" }}
      </button>
    </div>

    <div v-if="errMsg" class="bp-err">{{ errMsg }}</div>
    <div v-if="toast" class="bp-toast">{{ toast }}</div>
    <div class="bp-foot">计划仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.bp { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; overflow-y: auto; }
.bp-head { display: flex; align-items: center; justify-content: space-between; }
.bp-title { font-weight: 700; color: var(--text, #e6ecf5); font-size: 13px; display: flex; align-items: center; gap: 8px; }
.bp-status { font-size: 10px; font-weight: 600; }
.bp-actions { display: flex; gap: 6px; }
.bp-mini {
  padding: 2px 10px; border: 1px solid var(--border, #2a3344); border-radius: 6px;
  background: var(--bg-card, #15181f); color: var(--text, #dfe5f0);
  font-size: 10px; cursor: pointer;
}
.bp-mini:disabled { opacity: .6; cursor: default; }
.bp-mini:hover { border-color: var(--accent, #d4af37); color: var(--accent, #d4af37); }
.bp-primary { color: var(--accent, #d4af37); border-color: var(--accent, #d4af37); }
.bp-sub { color: var(--text-dim, #8a93a6); font-size: 10px; }
.bp-sec { font-size: 10px; color: var(--accent, #d4af37); font-weight: 700; display: flex; gap: 8px; align-items: center; }
.bp-md { color: var(--text, #d7deeb); line-height: 1.6; }
.bp-md :deep(ul), .bp-md :deep(ol) { padding-left: 18px; margin: 4px 0; }
.bp-md :deep(li) { margin: 2px 0; }
.bp-link {
  border: none; background: none; padding: 0; font-size: 10px; cursor: pointer;
  color: var(--text-dim, #93a0b8);
}
.bp-link:hover { color: var(--accent, #d4af37); }
.bp-drop:hover { color: #ff6b78; }
.bp-area {
  width: 100%; box-sizing: border-box; padding: 5px 7px; font-size: 11px; line-height: 1.5;
  border: 1px solid var(--border, #2a3344); border-radius: 6px; resize: vertical;
  background: var(--bg-card, #11141b); color: var(--text, #e6ecf5); margin: 3px 0;
}
.bp-row-actions { display: flex; gap: 6px; margin-top: 2px; }
.bp-cols { display: flex; gap: 8px; min-height: 0; }
.bp-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.bp-col-head { font-size: 11px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.bp-col-head i {
  font-style: normal; font-size: 10px; padding: 0 6px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.06); color: var(--text-dim, #aab2c4);
}
.bp-cards { display: flex; flex-direction: column; gap: 6px; }
.bp-card {
  border: 1px solid var(--border, #273041); border-radius: 9px; padding: 7px 9px;
  background: var(--bg-card, #141821); display: flex; flex-direction: column; gap: 3px;
}
.bp-card[data-status="done"] { opacity: .55; }
.bp-card[data-status="dropped"] { opacity: .4; border-style: dashed; }
.bp-card-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.bp-code { color: var(--text-dim, #9aa3b6); font-size: 10px; font-family: ui-monospace, Consolas, monospace; }
.bp-name { color: var(--text, #e6ecf5); font-weight: 600; }
.bp-theme { font-size: 10px; color: #5aa0ff; }
.bp-line { display: flex; gap: 6px; align-items: baseline; }
.bp-line b { color: var(--text-dim, #8a93a6); font-weight: 500; font-size: 10px; min-width: 28px; }
.bp-line span { color: var(--text, #cfd6e4); line-height: 1.45; font-size: 11px; }
.bp-card-foot { display: flex; gap: 10px; margin-top: 2px; flex-wrap: wrap; }
.bp-col-empty { color: var(--text-dim, #6a7488); font-size: 10px; text-align: center; padding: 8px; }
.bp-edit-label { font-size: 10px; color: var(--text-dim, #8a93a6); }
.bp-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
}
.empty-icon { font-size: 32px; }
.empty-title { font-size: 14px; font-weight: 600; color: var(--text, #e8dcc8); }
.empty-desc { font-size: 11px; color: var(--text-dim, #8a93a6); text-align: center; max-width: 280px; line-height: 1.6; }

.empty-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 300px;
  margin: 4px 0;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  background: var(--bg-card2, #1a1712);
  border: 1px solid var(--border, #2c2619);
  border-radius: 8px;
}
.step-num {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(212, 175, 55, 0.15);
  color: #d4af37;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.step-body { flex: 1; min-width: 0; }
.step-title { font-size: 11.5px; font-weight: 600; color: var(--text, #e8dcc8); }
.step-sub { font-size: 10px; color: var(--text-dim, #8a93a6); margin-top: 2px; line-height: 1.4; }

.bp-btn {
  padding: 6px 18px; border: 1px solid var(--accent, #d4af37); border-radius: 9px;
  background: var(--bg-card, #15181f); color: var(--accent, #d4af37);
  font-size: 12px; cursor: pointer;
}
.bp-btn.primary {
  background: linear-gradient(135deg, rgba(212,175,55,.15), rgba(212,175,55,.05));
  border-color: var(--accent, #d4af37);
}
.bp-btn:disabled { opacity: .6; cursor: default; }
.bp-err { color: #ff6b78; font-size: 11px; }
.bp-toast {
  position: sticky; bottom: 8px; align-self: center; font-size: 11px;
  padding: 5px 14px; border-radius: 14px; background: rgba(30, 40, 30, 0.92);
  color: #7fe0a0; border: 1px solid rgba(63, 207, 142, 0.4);
}
.bp-foot { color: var(--text-dim, #7a8496); font-size: 10px; }
</style>
