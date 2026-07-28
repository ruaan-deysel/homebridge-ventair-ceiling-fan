import type { DpValue } from '../dps.js';

export type DpsListener = (dps: Record<string, DpValue>) => void;

/**
 * Everything the plugin needs from a Tuya transport.
 *
 * The accessory depends only on this, never on tuyapi directly — tuyapi's author has
 * stopped active development, so the concrete implementation must stay swappable.
 */
export interface TuyaDevice {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  set(dps: Record<string, DpValue>): Promise<void>;
  get(): Promise<Record<string, DpValue>>;
  onDps(listener: DpsListener): void;
  onConnected(listener: () => void): void;
  onDisconnected(listener: () => void): void;
}

/** In-memory stand-in used by the accessory tests. No network, no timers. */
export class FakeTuyaDevice implements TuyaDevice {
  connected = false;
  state: Record<string, DpValue> = {};
  readonly writes: Record<string, DpValue>[] = [];

  private dpsListeners: DpsListener[] = [];
  private connectedListeners: (() => void)[] = [];
  private disconnectedListeners: (() => void)[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.connectedListeners.forEach(l => l());
  }

  disconnect(): void {
    this.connected = false;
    this.disconnectedListeners.forEach(l => l());
  }

  async set(dps: Record<string, DpValue>): Promise<void> {
    this.writes.push(dps);
    Object.assign(this.state, dps);
  }

  async get(): Promise<Record<string, DpValue>> {
    return { ...this.state };
  }

  onDps(l: DpsListener): void {
    this.dpsListeners.push(l);
  }

  onConnected(l: () => void): void {
    this.connectedListeners.push(l);
  }

  onDisconnected(l: () => void): void {
    this.disconnectedListeners.push(l);
  }

  /** Test helper: simulate the device pushing state. */
  emitDps(dps: Record<string, DpValue>): void {
    Object.assign(this.state, dps);
    this.dpsListeners.forEach(l => l(dps));
  }
}
