// 打法一键应用的默认预警联动：按 ALERT_TEMPLATES 创建，同名规则去重、不覆盖用户已启用项。
import { ALERT_TEMPLATES } from "./alertTemplates";
import { useAlertV2Store } from "../stores/alertV2";

/**
 * 确保预警模板存在：返回新创建条数。
 * 已存在同名规则（无论启用与否）一律跳过，避免重复、避免覆盖用户配置。
 */
export async function ensurePresetAlerts(keys: string[]): Promise<number> {
  const store = useAlertV2Store();
  if (!store.loaded) await store.load();
  let created = 0;
  for (const key of keys) {
    const tpl = ALERT_TEMPLATES.find((t) => t.key === key);
    if (!tpl) continue;
    const exists = store.rules.some((r) => r.name === tpl.name);
    if (exists) continue;
    await store.save(tpl.build());
    created++;
  }
  return created;
}
