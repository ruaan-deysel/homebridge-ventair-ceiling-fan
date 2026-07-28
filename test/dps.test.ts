import { describe, expect, it } from 'vitest';
import { DP, percentToStep, stepToPercent, toDps, toFanState } from '../src/dps.js';

describe('speed conversion', () => {
  it('round-trips every step', () => {
    for (let step = 0; step <= 5; step++) {
      expect(percentToStep(stepToPercent(step))).toBe(step);
    }
  });

  it('maps steps to the expected percentages', () => {
    expect([0, 1, 2, 3, 4, 5].map(stepToPercent)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('clamps out-of-range percentages', () => {
    expect(percentToStep(-10)).toBe(0);
    expect(percentToStep(999)).toBe(5);
  });
});

describe('toFanState', () => {
  it('reads a full device payload', () => {
    const state = toFanState({
      [DP.power]: true,
      [DP.mode]: 'sleep',
      [DP.speed]: 3,
      [DP.direction]: 'reverse',
    }, { brightnessScale: 100 });

    expect(state).toEqual({
      power: true, mode: 'sleep', speedStep: 3, direction: 'reverse',
    });
  });

  it('ignores absent datapoints rather than inventing defaults', () => {
    expect(toFanState({ [DP.power]: false }, { brightnessScale: 100 })).toEqual({ power: false });
  });

  it('normalises mode case, since the device reports "Normal" but accepts "normal"', () => {
    expect(toFanState({ [DP.mode]: 'Normal' }, { brightnessScale: 100 }).mode).toBe('normal');
    expect(toFanState({ [DP.mode]: 'Sleep' }, { brightnessScale: 100 }).mode).toBe('sleep');
  });

  it('preserves an unrecognised mode rather than discarding it', () => {
    // The cloud enum was incomplete once already — dropping unknowns would have
    // silently discarded "Normal", the live value on all eight fans.
    expect(toFanState({ [DP.mode]: 'turbo' }, { brightnessScale: 100 }).mode).toBe('turbo');
  });

  it('treats an absent speed datapoint as unknown, not zero', () => {
    // Two of the eight fans omit DP 3 entirely.
    expect(toFanState({ [DP.power]: false }, { brightnessScale: 100 }).speedStep).toBeUndefined();
  });

  it('scales brightness from the device range to percent', () => {
    expect(toFanState({ [DP.lightBrightness]: 500 }, { brightnessScale: 1000 }).lightBrightness).toBe(50);
    expect(toFanState({ [DP.lightBrightness]: 50 }, { brightnessScale: 100 }).lightBrightness).toBe(50);
  });
});

describe('toDps', () => {
  it('writes speed as a step, not a percentage', () => {
    expect(toDps({ speedStep: 4 }, { brightnessScale: 100 })).toEqual({ [DP.speed]: 4 });
  });

  it('scales brightness back to the device range', () => {
    expect(toDps({ lightBrightness: 50 }, { brightnessScale: 1000 })).toEqual({ [DP.lightBrightness]: 500 });
  });

  it('emits only the keys present in the patch', () => {
    expect(Object.keys(toDps({ power: true }, { brightnessScale: 100 }))).toEqual([DP.power]);
  });
});
