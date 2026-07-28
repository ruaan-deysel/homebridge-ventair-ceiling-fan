import type { Logging } from 'homebridge';
import TuyAPI from 'tuyapi';
import type { DpValue } from '../dps.js';
import type { DpsListener, TuyaDevice } from './device.js';

export interface TuyapiOptions {
  id: string;
  key: string;
  version: string;
  ip?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export class TuyapiDevice implements TuyaDevice {
  private readonly device: TuyAPI;
  private readonly dpsListeners: DpsListener[] = [];
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  /** Non-null while a connect attempt is in flight — the guard against overlapping loops. */
  private inFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly opts: TuyapiOptions, private readonly log: Logging) {
    this.device = new TuyAPI({
      id: opts.id,
      key: opts.key,
      ip: opts.ip,
      version: opts.version,
      // Do NOT set issueRefreshOnConnect: tuyapi calls refresh() internally on
      // every connect when this is set, fire-and-forget, and refresh() was
      // measured to hang 20s against healthy hardware. The timeout then fires
      // 'error', which schedules a spurious reconnect on every healthy
      // connection. Initial state comes from the onConnected -> get({ schema: true })
      // path below instead.
    });

    // Both events previously called connect() directly, which allowed two retry
    // loops to run concurrently. They now funnel through the same guarded path.
    this.device.on('disconnected', () => {
      this.connectedState = false;
      this.disconnectedListeners.forEach(l => l());
      this.scheduleReconnect('disconnected');
    });

    this.device.on('error', (error: Error) => {
      this.log.debug(`[${this.opts.id}] transport error: ${error.message}`);
      this.scheduleReconnect('error');
    });

    this.device.on('connected', () => {
      this.connectedState = true;
      this.attempt = 0;
      this.connectedListeners.forEach(l => l());
    });

    // tuyapi's own `Object` dp-value type is broader (allows nested objects/arrays)
    // than our `DpValue`; cast through `unknown` since hardware never sends those.
    const forward = (data: unknown) => {
      const dps = (data as { dps?: Record<string, DpValue> } | undefined)?.dps;
      if (dps) {
        this.dpsListeners.forEach(l => l(dps));
      }
    };
    this.device.on('data', forward);
    this.device.on('dp-refresh', forward);
  }

  private connectedState = false;

  get connected(): boolean {
    return this.connectedState;
  }

  /** Exposed for tests to assert backoff growth. */
  get nextDelayMs(): number {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
  }

  async connect(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return this.inFlight ?? undefined;
    }
    this.inFlight = this.attemptConnect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async attemptConnect(): Promise<void> {
    try {
      if (!this.opts.ip) {
        await this.device.find();
      }
      await this.device.connect();
      this.log.info(`[${this.opts.id}] connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = jitter(this.nextDelayMs);
      this.attempt++;
      this.log.warn(`[${this.opts.id}] connect failed (${message}); retrying in ${Math.round(delay / 1000)}s`);
      this.armRetry(delay);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.inFlight || this.retryTimer) {
      return;
    }
    this.log.debug(`[${this.opts.id}] scheduling reconnect (${reason})`);
    this.armRetry(jitter(this.nextDelayMs));
  }

  private armRetry(delay: number): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connectedState = false;
    this.device.disconnect();
  }

  /**
   * One `set()` call per datapoint, sequentially.
   *
   * Measured on real Ventair Skyfan DC hardware: `set({ multiple: true, data })`
   * is accepted with no error but silently has NO EFFECT on this firmware — do
   * not "optimise" this back into a batched write. Sequential because there is
   * one TCP connection per device; concurrent writes on it are not worth the risk.
   */
  async set(dps: Record<string, DpValue>): Promise<void> {
    for (const [dp, value] of Object.entries(dps)) {
      await this.device.set({ dps: Number(dp), set: value, shouldWaitForResponse: false });
    }
  }

  async get(): Promise<Record<string, DpValue>> {
    const result = await this.device.get({ schema: true });
    if (result && typeof result === 'object' && 'dps' in result) {
      return (result as { dps: Record<string, DpValue> }).dps;
    }
    return {};
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
}

/** Spread retries so eight fans reconnecting after a network blip don't sync up. */
function jitter(delay: number): number {
  return delay * (0.5 + Math.random() / 2);
}
