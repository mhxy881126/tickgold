// 预警提示音：WebAudio 现场合成，无需音频文件
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  gain = 0.14
) {
  const ac = getCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ac.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** 上涨类：清脆两声上扬 */
export function playUp() {
  beep(880, 0, 0.12, "sine");
  beep(1320, 0.09, 0.2, "sine");
}

/** 下跌类：低沉两声下沉 */
export function playDown() {
  beep(520, 0, 0.14, "triangle");
  beep(330, 0.1, 0.24, "triangle");
}

/** 按预警 tone 播放（up / down） */
export function playAlert(toneKind: string) {
  if (toneKind === "up") playUp();
  else playDown();
}
