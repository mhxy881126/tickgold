import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installAudioContext() {
  const oscillators: any[] = [];
  const gains: any[] = [];
  const connections: string[] = [];

  class Oscillator {
    type = "";
    frequency = { value: 0 };
    connect = vi.fn((node: unknown) => {
      connections.push(`osc->${(node as { kind: string }).kind}`);
    });
    start = vi.fn();
    stop = vi.fn();
    kind = "gain";
    constructor() {
      oscillators.push(this);
    }
  }

  class Gain {
    gain = {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    };
    connect = vi.fn((node: unknown) => {
      connections.push(`gain->${(node as { kind: string }).kind}`);
    });
    kind = "gain"; // 本节点是 gain；ac.destination 才是 { kind: "destination" }
    constructor() {
      gains.push(this);
    }
  }

  const resume = vi.fn(() => Promise.resolve());
  class AudioContext {
    state = "suspended";
    currentTime = 1;
    destination = { kind: "destination" };
    resume = resume;
    createOscillator = vi.fn(() => new Oscillator());
    createGain = vi.fn(() => new Gain());
  }

  (globalThis as any).window = { AudioContext, webkitAudioContext: undefined };
  return { AudioContext, oscillators, gains, connections, resume };
}

describe("sound", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it("synthesizes the rising two-tone alert and resumes a suspended context", async () => {
    const audio = installAudioContext();
    const { playUp } = await import("../../../src/utils/sound");

    playUp();
    await Promise.resolve();

    expect(audio.resume).toHaveBeenCalledTimes(2);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([880, 1320]);
    expect(audio.oscillators.map((o) => o.type)).toEqual(["sine", "sine"]);
    expect(audio.connections).toContain("osc->gain");
    expect(audio.connections).toContain("gain->destination");
    expect(audio.oscillators[0].start).toHaveBeenCalledWith(1);
    expect(audio.oscillators[1].start).toHaveBeenCalledWith(1.09);
  });

  it("synthesizes the falling two-tone alert", async () => {
    const audio = installAudioContext();
    const { playDown } = await import("../../../src/utils/sound");

    playDown();

    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([520, 330]);
    expect(audio.oscillators.map((o) => o.type)).toEqual(["triangle", "triangle"]);
  });

  it("selects a tone by alert kind", async () => {
    const audio = installAudioContext();
    const { playAlert } = await import("../../../src/utils/sound");

    playAlert("up");
    playAlert("down");
    playAlert("unknown");

    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([
      880, 1320, 520, 330, 520, 330,
    ]);
  });

  it("supports a webkit-prefixed AudioContext", async () => {
    const audio = installAudioContext();
    (globalThis as any).window = {
      AudioContext: undefined,
      webkitAudioContext: audio.AudioContext,
    };
    const { playUp } = await import("../../../src/utils/sound");

    expect(() => playUp()).not.toThrow();
    expect(audio.oscillators).toHaveLength(2);
  });

  it("silently ignores AudioContext construction failure", async () => {
    (globalThis as any).window = {
      AudioContext: class {
        constructor() {
          throw new Error("blocked");
        }
      },
    };
    const { playAlert } = await import("../../../src/utils/sound");

    expect(() => playAlert("up")).not.toThrow();
  });
});
