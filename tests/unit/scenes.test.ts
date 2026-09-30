import { describe, it, expect } from "vitest";
import { SCENES } from "../../src/lib/scenes";

describe("scene presets fit the 12x6 one-screen board", () => {
  for (const scene of SCENES) {
    it(`${scene.id} totals 72 cells`, () => {
      const cells = scene.cards.reduce((sum, id) => {
        const s = scene.size?.[id];
        expect(s, `${scene.id}/${id} missing size`).toBeTruthy();
        return sum + s!.w * s!.h;
      }, 0);
      expect(cells).toBe(72);
    });
  }
});
