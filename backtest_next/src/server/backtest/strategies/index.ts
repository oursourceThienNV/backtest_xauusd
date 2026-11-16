import { AdxStrategy } from './adx';
import type { StrategyClass } from './base';
import { BollingerStrategy } from './bollinger';
import { MaCrossStrategy } from './maCross';
import { STRATEGY_META, type StrategyMeta } from './meta';
import { SmaRsiStrategy } from './smaRsi';

export type StrategySpec = StrategyMeta & { cls: StrategyClass };

const CLASSES: Record<string, StrategyClass> = {
  ma_cross: MaCrossStrategy,
  bollinger: BollingerStrategy,
  adx: AdxStrategy,
  sma_rsi: SmaRsiStrategy,
};

export const STRATEGIES: Record<string, StrategySpec> = Object.fromEntries(
  Object.entries(STRATEGY_META).map(([k, m]) => [k, { ...m, cls: CLASSES[k] }]),
);

export const isStrategy = (key: any): key is string => typeof key === 'string' && key in STRATEGIES;

const clone = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

export function defaults(key: string): Record<string, any> {
  return Object.fromEntries(STRATEGIES[key].fields.map((f) => [f.key, clone(f.default)]));
}

export function mergedConfig(key: string, cfg?: Record<string, any> | null) {
  const out = defaults(key);
  for (const [k, v] of Object.entries(cfg || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function metadata() {
  return Object.entries(STRATEGIES).map(([key, s]) => ({
    key,
    name: s.name,
    color: s.color,
    timeframes: s.timeframes,
    summary: s.summary,
    steps: s.steps,
    fields: s.fields,
    presets: s.presets || {},
    defaults: defaults(key),
  }));
}
