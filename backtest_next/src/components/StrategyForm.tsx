'use client';

import type { StrategyField, StrategyMeta } from '@/lib/types';

type Props = {
  meta: StrategyMeta;
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
};

function Field({ f, value, set }: { f: StrategyField; value: any; set: (v: any) => void }) {
  if (f.type === 'bool') {
    return (
      <label className="switch-row">
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        <span className="switch" />
        <span className="switch-content">
          <strong>{f.label}</strong>
          {f.help && <small>{f.help}</small>}
        </span>
      </label>
    );
  }

  if (f.type === 'select') {
    return (
      <label>
        {f.label}
        <select value={value ?? ''} onChange={(e) => set(e.target.value)}>
          {(f.options || []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }

  if (f.type === 'time') {
    return (
      <label>
        {f.label}
        <input type="time" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      </label>
    );
  }

  if (f.type === 'lots') {
    const lots: (number | string)[] = Array.isArray(value) ? value : [];
    return (
      <div className="lots-field">
        <div className="lots-title">{f.label}</div>
        <div className="lots-grid">
          {[0, 1, 2, 3, 4].map((k) => (
            <label key={k}>
              L{k + 1}
              <input
                type="number"
                step={0.01}
                min={0}
                value={lots[k] ?? ''}
                onChange={(e) => {
                  const next = [...lots];
                  next[k] = e.target.value === '' ? '' : Number(e.target.value);
                  set(next);
                }}
              />
            </label>
          ))}
        </div>
      </div>
    );
  }

  return (
    <label>
      {f.label}
      <input
        type="number"
        value={value ?? ''}
        min={f.min}
        max={f.max}
        step={f.step ?? 'any'}
        onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </label>
  );
}

export default function StrategyForm({ meta, values, onChange }: Props) {
  const groups: { name: string; fields: StrategyField[] }[] = [];

  for (const f of meta.fields) {
    if (f.show_if && !values[f.show_if]) continue;
    let g = groups.find((x) => x.name === f.group);
    if (!g) {
      g = { name: f.group, fields: [] };
      groups.push(g);
    }
    g.fields.push(f);
  }

  const set = (key: string) => (v: any) => onChange({ ...values, [key]: v });
  const presets = Object.entries(meta.presets || {});

  return (
    <div className="strategy-form">
      {presets.length > 0 && (
        <div className="preset-row">
          {presets.map(([key, p]) => (
            <button key={key} type="button" className="lot-preset" onClick={() => onChange({ ...values, ...p.values })}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {groups.map((g) => {
        const numbers = g.fields.filter((f) => f.type === 'number' || f.type === 'select' || f.type === 'time');
        const others = g.fields.filter((f) => !(f.type === 'number' || f.type === 'select' || f.type === 'time'));
        return (
          <div key={g.name} className="form-group">
            <div className="section-title space">{g.name.toUpperCase()}</div>
            {others.length > 0 && (
              <div className="strategy-option">
                {others.map((f) => (
                  <Field key={f.key} f={f} value={values[f.key]} set={set(f.key)} />
                ))}
              </div>
            )}
            {numbers.length > 0 && (
              <div className="two">
                {numbers.map((f) => (
                  <Field key={f.key} f={f} value={values[f.key]} set={set(f.key)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
