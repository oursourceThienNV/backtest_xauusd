import { marketService } from '@/services';

/**
 * Nạp tick từ backend theo từng gói (mặc định 30.000 tick), nạp trước gói kế tiếp
 * khi sắp dùng hết -> replay chạy liên tục, đúng thứ tự tick đã xảy ra.
 */

type TickChunk = {
  count: number;
  t0: number | null;
  dt: number[];
  base: number | null;
  scale?: number;
  b: number[];
  s: number[];
  last_ms: number | null;
};

const CHUNK = 30000;
const PREFETCH_WHEN_LEFT = 15000;
const TRIM_AFTER = 120000;

export class TickFeed {
  t: number[] = [];
  bid: number[] = [];
  ask: number[] = [];
  head = 0;
  ended = false;
  loading: Promise<void> | null = null;
  private nextFrom = 0;
  private generation = 0;

  constructor(private symbol: string | undefined, private endMs: number) {}

  async reset(fromMs: number) {
    this.generation += 1;
    this.t = [];
    this.bid = [];
    this.ask = [];
    this.head = 0;
    this.ended = false;
    this.loading = null;
    this.nextFrom = fromMs;
    await this.fetchMore();
  }

  get available() {
    return this.t.length - this.head;
  }

  peekTime(): number | null {
    return this.head < this.t.length ? this.t[this.head] : null;
  }

  /** Gọi mỗi khung hình: nạp trước nếu sắp hết. */
  maintain() {
    if (!this.ended && !this.loading && this.available < PREFETCH_WHEN_LEFT) {
      this.fetchMore();
    }
    if (this.head > TRIM_AFTER) {
      this.t = this.t.slice(this.head);
      this.bid = this.bid.slice(this.head);
      this.ask = this.ask.slice(this.head);
      this.head = 0;
    }
  }

  fetchMore(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.loading) return this.loading;

    const gen = this.generation;
    const from = this.nextFrom;

    this.loading = (marketService.ticks({ from_ms: from, limit: CHUNK, to_ms: this.endMs, symbol: this.symbol }) as Promise<TickChunk>)
      .then((c) => {
        if (gen !== this.generation) return;
        this.append(c);
      })
      .catch(() => {
        if (gen !== this.generation) return;
        // lỗi mạng: thử lại ở lần maintain() sau
      })
      .finally(() => {
        if (gen === this.generation) this.loading = null;
      });

    return this.loading;
  }

  private append(c: TickChunk) {
    if (!c.count || c.t0 === null || c.base === null) {
      this.ended = true;
      return;
    }

    const scale = c.scale || 1000;
    let t = c.t0;

    for (let i = 0; i < c.count; i++) {
      t += i === 0 ? 0 : c.dt[i];
      const bid = c.base + c.b[i] / scale;
      this.t.push(t);
      this.bid.push(bid);
      this.ask.push(bid + c.s[i] / scale);
    }

    this.nextFrom = (c.last_ms ?? t) + 1;

    if (c.count < CHUNK || (c.last_ms !== null && c.last_ms >= this.endMs - 1)) {
      this.ended = true;
    }
  }
}
