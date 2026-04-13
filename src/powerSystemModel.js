/** Default 8-bus style example (editable in UI). */
export const DEFAULT_SYSTEM = {
  GENERATORS: [
    { bus: 0, name: "Gen 1 (Slack)", Pmin: 10, Pmax: 200, a: 0.02, b: 20, vset: 1.0 },
    { bus: 1, name: "Gen 2", Pmin: 10, Pmax: 150, a: 0.025, b: 18, vset: 1.0 },
    { bus: 4, name: "Gen 3", Pmin: 10, Pmax: 120, a: 0.03, b: 22, vset: 1.0 },
    { bus: 6, name: "Gen 4", Pmin: 10, Pmax: 180, a: 0.015, b: 25, vset: 1.0 },
  ],
  LOADS: [
    { bus: 2, name: "Load A", P: 50, Q: 20 },
    { bus: 3, name: "Load B", P: 40, Q: 15 },
    { bus: 5, name: "Load C", P: 60, Q: 25 },
    { bus: 7, name: "Load D", P: 35, Q: 10 },
  ],
  LINES: [
    { from: 0, to: 1, name: "Line 0-1", r: 0.05, x: 0.11, b: 0.02 },
    { from: 1, to: 2, name: "Line 1-2", r: 0.04, x: 0.09, b: 0.02 },
    { from: 2, to: 3, name: "Line 2-3", r: 0.06, x: 0.13, b: 0.01 },
    { from: 1, to: 4, name: "Line 1-4", r: 0.03, x: 0.08, b: 0.02 },
    { from: 4, to: 5, name: "Line 4-5", r: 0.05, x: 0.1, b: 0.01 },
    { from: 3, to: 5, name: "Line 3-5", r: 0.04, x: 0.12, b: 0.02 },
    { from: 5, to: 6, name: "Line 5-6", r: 0.03, x: 0.07, b: 0.01 },
    { from: 6, to: 7, name: "Line 6-7", r: 0.05, x: 0.11, b: 0.02 },
    { from: 0, to: 7, name: "Line 0-7", r: 0.04, x: 0.09, b: 0.01 },
  ],
  /** Normalized diagram coords { nx, ny } in [0,1] per bus; omit or {} for auto layout. */
  LAYOUT: {},
};

export function collectBuses(system) {
  const s = new Set();
  for (const g of system.GENERATORS || []) s.add(Number(g.bus));
  for (const l of system.LOADS || []) s.add(Number(l.bus));
  for (const e of system.LINES || []) {
    s.add(Number(e.from));
    s.add(Number(e.to));
  }
  return [...s].sort((a, b) => a - b);
}

function slackBus(system) {
  const gens = system.GENERATORS || [];
  const slack = gens.find((g) => /slack/i.test(String(g.name || "")));
  if (slack != null) return Number(slack.bus);
  if (gens[0]) return Number(gens[0].bus);
  const buses = collectBuses(system);
  return buses[0] ?? 0;
}

/**
 * Layered layout from graph of LINES; returns Map bus -> { x, y } in local coords.
 */
export function computeBasePositions(system, width, height) {
  const buses = collectBuses(system);
  const pos = new Map();
  if (buses.length === 0) return pos;

  const adj = new Map();
  for (const b of buses) adj.set(b, []);
  for (const ln of system.LINES || []) {
    const a = Number(ln.from);
    const b = Number(ln.to);
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a).push(b);
    adj.get(b).push(a);
  }

  const start = slackBus(system);
  const layer = new Map();
  const q = [start];
  layer.set(start, 0);
  while (q.length) {
    const u = q.shift();
    for (const v of adj.get(u) || []) {
      if (!layer.has(v)) {
        layer.set(v, layer.get(u) + 1);
        q.push(v);
      }
    }
  }

  let reachMax = 0;
  for (const b of buses) {
    if (layer.has(b)) reachMax = Math.max(reachMax, layer.get(b));
  }
  for (const b of buses) {
    if (!layer.has(b)) layer.set(b, reachMax + 1);
  }

  const layers = new Map();
  for (const b of buses) {
    const L = layer.get(b);
    if (!layers.has(L)) layers.set(L, []);
    layers.get(L).push(b);
  }
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);

  const marginX = 72;
  const marginY = 56;
  const innerW = Math.max(1, width - 2 * marginX);
  const innerH = Math.max(1, height - 2 * marginY);
  const nL = sortedLayers.length || 1;
  const dx = nL > 1 ? innerW / (nL - 1) : 0;

  sortedLayers.forEach((L, li) => {
    const row = [...layers.get(L)].sort((a, b) => a - b);
    const n = row.length;
    row.forEach((bus, i) => {
      const x = marginX + li * dx;
      const y =
        marginY +
        innerH / 2 +
        (n === 1 ? 0 : (i - (n - 1) / 2) * Math.min(88, innerH / Math.max(n - 1, 1)));
      pos.set(bus, { x, y });
    });
  });

  return pos;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * Final pixel positions: saved LAYOUT (nx, ny) overrides auto layout per bus.
 */
export function computeMergedPositions(system, width, height) {
  const base = computeBasePositions(system, width, height);
  const layoutRaw = system.LAYOUT && typeof system.LAYOUT === "object" ? system.LAYOUT : {};
  const m = new Map();
  for (const bus of collectBuses(system)) {
    const ent = layoutRaw[String(bus)];
    const nx = ent && Number(ent.nx);
    const ny = ent && Number(ent.ny);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      m.set(bus, { x: clamp01(nx) * width, y: clamp01(ny) * height });
    } else {
      const b = base.get(bus);
      if (b) m.set(bus, { x: b.x, y: b.y });
    }
  }
  return m;
}

/** @deprecated layout uses bus-bar geometry; kept for any hit heuristics */
export function busSymbolRadius(system, bus) {
  const role = busRole(system, bus);
  if (role === "slack") return 25;
  if (role === "gen") return 22;
  if (role === "load") return 11;
  return 16;
}

/** Local-space layout (origin = bus junction; +y down). */
export const BUS_GRAPHIC = {
  barHalf: 26,
  loadR: 11,
  loadCy: -32,
  stubLoadLen: 18,
  genR: 22,
  genRSlack: 25,
  genCy: 40,
  stubGenLen: 18,
  splitX: 16,
};

/** Short tag: never label a generator or load as only “bus”. */
export function busTag(system, bus) {
  const role = busRole(system, bus);
  if (role === "slack") return `S${bus}`;
  if (role === "gen") return `G${bus}`;
  if (role === "load") return `L${bus}`;
  return `Bus ${bus}`;
}

export function busSpecLines(system, bus) {
  const gen = (system.GENERATORS || []).find((g) => Number(g.bus) === bus);
  const load = (system.LOADS || []).find((l) => Number(l.bus) === bus);
  if (gen && /slack/i.test(String(gen.name || ""))) {
    return [
      "Slack generator",
      gen.name || `G${bus}`,
      `Network bus ${bus}`,
      `P limits: ${gen.Pmin}–${gen.Pmax} MW`,
      `Cost: a = ${gen.a}, b = ${gen.b}`,
      `Voltage setpoint: ${gen.vset} pu`,
    ];
  }
  if (gen) {
    return [
      "Generator",
      gen.name || `G${bus}`,
      `Network bus ${bus}`,
      `P limits: ${gen.Pmin}–${gen.Pmax} MW`,
      `Cost: a = ${gen.a}, b = ${gen.b}`,
      `Voltage setpoint: ${gen.vset} pu`,
    ];
  }
  if (load) {
    return [
      "Load",
      load.name || `L${bus}`,
      `Network bus ${bus}`,
      `P = ${load.P} MW`,
      `Q = ${load.Q} MVAr`,
    ];
  }
  return ["Junction (bus bar only)", `Bus ${bus} — shift-click two buses to add a branch`];
}

export function lineSpecLines(ln) {
  return [
    ln.name || `Line ${ln.from}–${ln.to}`,
    `Between buses ${ln.from} and ${ln.to}`,
    `r = ${ln.r},  x = ${ln.x},  b = ${ln.b}`,
  ];
}

export function systemToPrettyJson(system) {
  return JSON.stringify(
    {
      GENERATORS: system.GENERATORS || [],
      LOADS: system.LOADS || [],
      LINES: system.LINES || [],
      LAYOUT: system.LAYOUT && typeof system.LAYOUT === "object" ? system.LAYOUT : {},
    },
    null,
    2
  );
}

export function parseSystemJson(text) {
  const o = JSON.parse(text);
  if (!o || typeof o !== "object") throw new Error("Root must be an object");
  const layout = o.LAYOUT && typeof o.LAYOUT === "object" && !Array.isArray(o.LAYOUT) ? { ...o.LAYOUT } : {};
  return {
    GENERATORS: Array.isArray(o.GENERATORS) ? o.GENERATORS : [],
    LOADS: Array.isArray(o.LOADS) ? o.LOADS : [],
    LINES: Array.isArray(o.LINES) ? o.LINES : [],
    LAYOUT: layout,
  };
}

export function busRole(system, bus) {
  const g = (system.GENERATORS || []).find((x) => Number(x.bus) === bus);
  const l = (system.LOADS || []).find((x) => Number(x.bus) === bus);
  if (g && /slack/i.test(String(g.name || ""))) return "slack";
  if (g) return "gen";
  if (l) return "load";
  return "bus";
}
