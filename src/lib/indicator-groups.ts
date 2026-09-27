// 副图指标目录（KLineChart 内置指标，按类分组）
// 从 StockChart.vue 抽出，纯静态数据，供副图选择菜单渲染。
export interface SubIndicator {
  name: string;
  label: string;
}
export interface SubIndicatorGroup {
  group: string;
  items: SubIndicator[];
}

export const SUB_GROUPS: SubIndicatorGroup[] = [
  {
    group: "常用",
    items: [
      { name: "MACD", label: "MACD 指数平滑异同" },
      { name: "KDJ", label: "KDJ 随机指标" },
      { name: "RSI", label: "RSI 相对强弱" },
      { name: "WR", label: "WR 威廉指标" },
      { name: "CCI", label: "CCI 顺势指标" },
    ],
  },
  {
    group: "趋势",
    items: [
      { name: "DMI", label: "DMI 趋向指标" },
      { name: "DMA", label: "DMA 平均差" },
      { name: "TRIX", label: "TRIX 三重平滑" },
      { name: "MTM", label: "MTM 动量指标" },
      { name: "ROC", label: "ROC 变动率" },
      { name: "BIAS", label: "BIAS 乖离率" },
    ],
  },
  {
    group: "量能 / 资金",
    items: [
      { name: "OBV", label: "OBV 能量潮" },
      { name: "VR", label: "VR 容量比率" },
      { name: "EMV", label: "EMV 简易波动" },
      { name: "PVT", label: "PVT 量价趋势" },
      { name: "AO", label: "AO 动量震荡" },
      { name: "AVP", label: "AVP 量价指标" },
    ],
  },
  {
    group: "其他",
    items: [
      { name: "BRAR", label: "BRAR 情绪指标" },
      { name: "CR", label: "CR 能量指标" },
      { name: "PSY", label: "PSY 心理线" },
    ],
  },
];
