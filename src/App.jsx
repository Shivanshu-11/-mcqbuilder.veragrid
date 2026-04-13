import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  BUS_GRAPHIC,
  DEFAULT_SYSTEM,
  busSpecLines,
  collectBuses,
  computeMergedPositions,
  lineSpecLines,
  parseSystemJson,
  systemToPrettyJson,
} from "./powerSystemModel.js";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="ps-error">
          <h2>Something went wrong</h2>
          <pre>{String(this.state.error?.message || this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function clientToSvg(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  return ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
}

function nearestBus(svgX, svgY, positions, excludeBus, hitPx = 38) {
  let best = null;
  let bestD = Infinity;
  for (const [bus, p] of positions) {
    if (bus === excludeBus) continue;
    const d = Math.hypot(p.x - svgX, p.y - svgY);
    if (d < hitPx && d < bestD) {
      bestD = d;
      best = bus;
    }
  }
  return best;
}

function localWireOrigin(part, system, bus) {
  const G = BUS_GRAPHIC;
  const gen = (system.GENERATORS || []).find((g) => Number(g.bus) === bus);
  const load = (system.LOADS || []).find((l) => Number(l.bus) === bus);
  const both = gen && load;
  if (part === "load") return { x: both ? -G.splitX : 0, y: G.loadCy };
  if (part === "gen") return { x: both ? G.splitX : 0, y: G.genCy };
  return { x: 0, y: 0 };
}

function CircuitDiagram({
  system,
  onBusDragEnd,
  onWireComplete,
  selectedBus,
  onSelectBus,
  highlightLineIndex,
}) {
  const svgRef = useRef(null);
  const [size, setSize] = useState({ w: 640, h: 420 });
  /** Live pixel center while dragging a bus */
  const [liveBus, setLiveBus] = useState(null);
  /** Rubber-band line while dragging from a connection handle */
  const [wire, setWire] = useState(null);
  const interactionRef = useRef(null);
  const frameRef = useRef(null);
  const [hoverTip, setHoverTip] = useState(null);
  /** Shift-click first bus, shift-click second to add a line (junctions). */
  const shiftPendingRef = useRef(null);
  const [, setShiftArm] = useState(0);
  // bus | wire | pendingWire (drag from gen/load circle to branch)

  useEffect(() => {
    shiftPendingRef.current = null;
    setShiftArm((x) => x + 1);
  }, [system]);

  const tapShiftLink = useCallback(
    (bus) => {
      const p = shiftPendingRef.current;
      if (p == null) {
        shiftPendingRef.current = bus;
        setShiftArm((x) => x + 1);
        return;
      }
      if (p === bus) {
        shiftPendingRef.current = null;
        setShiftArm((x) => x + 1);
        return;
      }
      shiftPendingRef.current = null;
      setShiftArm((x) => x + 1);
      onWireComplete(p, bus);
    },
    [onWireComplete]
  );

  const shiftLinkFrom = shiftPendingRef.current;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(320, r.width), h: Math.max(280, r.height) });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: Math.max(320, r.width), h: Math.max(280, r.height) });
    return () => ro.disconnect();
  }, []);

  const basePositions = useMemo(
    () => computeMergedPositions(system, size.w, size.h),
    [system, size.w, size.h]
  );

  const positions = useMemo(() => {
    const m = new Map(basePositions);
    if (liveBus) m.set(liveBus.bus, { x: liveBus.x, y: liveBus.y });
    return m;
  }, [basePositions, liveBus]);

  const endInteraction = useCallback(
    (e) => {
      const svg = svgRef.current;
      const cur = svg ? clientToSvg(svg, e.clientX, e.clientY) : { x: 0, y: 0 };
      const it = interactionRef.current;
      interactionRef.current = null;

      if (it?.type === "pendingWire") {
        setWire(null);
        try {
          if (e.currentTarget && e.pointerId != null) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        } catch {
          /* ignore */
        }
        return;
      }

      if (it?.type === "bus") {
        const x = it.lastX ?? basePositions.get(it.bus)?.x ?? 0;
        const y = it.lastY ?? basePositions.get(it.bus)?.y ?? 0;
        onBusDragEnd(it.bus, clamp01(x / size.w), clamp01(y / size.h));
        setLiveBus(null);
      }

      if (it?.type === "wire") {
        const target = nearestBus(cur.x, cur.y, positions, it.fromBus);
        if (target != null) onWireComplete(it.fromBus, target);
        setWire(null);
      }

      try {
        if (e.currentTarget && e.pointerId != null) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
    },
    [basePositions, onBusDragEnd, onWireComplete, positions, size.h, size.w]
  );

  const onSvgPointerMove = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const cur = clientToSvg(svg, e.clientX, e.clientY);
    const it = interactionRef.current;

    if (it?.type === "bus") {
      const x = cur.x - it.ox;
      const y = cur.y - it.oy;
      it.lastX = x;
      it.lastY = y;
      setLiveBus({ bus: it.bus, x, y });
    } else if (it?.type === "pendingWire") {
      const d = Math.hypot(cur.x - it.px, cur.y - it.py);
      if (d > 8) {
        interactionRef.current = {
          type: "wire",
          fromBus: it.fromBus,
          x1: it.originX,
          y1: it.originY,
          pointerId: it.pointerId,
        };
        setWire({
          x1: it.originX,
          y1: it.originY,
          x2: cur.x,
          y2: cur.y,
          fromBus: it.fromBus,
        });
      }
    } else if (it?.type === "wire") {
      setWire({ x1: it.x1, y1: it.y1, x2: cur.x, y2: cur.y, fromBus: it.fromBus });
    }
  }, []);

  const onSvgPointerUp = useCallback(
    (e) => {
      if (interactionRef.current) endInteraction(e);
    },
    [endInteraction]
  );

  /** Drag the bus bar to move the whole node (junction tap for lines is geometric center). */
  const onPointerDownBar = useCallback(
    (e, bus) => {
      e.stopPropagation();
      if (e.button !== 0) return;

      if (e.shiftKey) {
        tapShiftLink(bus);
        return;
      }

      onSelectBus(bus);
      const svg = svgRef.current;
      if (!svg) return;
      const p = positions.get(bus);
      if (!p) return;
      const cur = clientToSvg(svg, e.clientX, e.clientY);
      interactionRef.current = {
        type: "bus",
        bus,
        ox: cur.x - p.x,
        oy: cur.y - p.y,
        pointerId: e.pointerId,
        lastX: p.x,
        lastY: p.y,
      };
      setLiveBus({ bus, x: p.x, y: p.y });
      svg.setPointerCapture(e.pointerId);
    },
    [onSelectBus, positions, tapShiftLink]
  );

  /** Drag from generator or load circle to draw a new branch (release on another bus). */
  const onPointerDownEquip = useCallback(
    (e, bus, part) => {
      e.stopPropagation();
      if (e.button !== 0) return;

      if (e.shiftKey) {
        tapShiftLink(bus);
        return;
      }

      onSelectBus(bus);
      const svg = svgRef.current;
      if (!svg) return;
      const p = positions.get(bus);
      if (!p) return;
      const lo = localWireOrigin(part, system, bus);
      const cur = clientToSvg(svg, e.clientX, e.clientY);
      const originX = p.x + lo.x;
      const originY = p.y + lo.y;
      interactionRef.current = {
        type: "pendingWire",
        fromBus: bus,
        originX,
        originY,
        px: cur.x,
        py: cur.y,
        pointerId: e.pointerId,
      };
      svg.setPointerCapture(e.pointerId);
    },
    [onSelectBus, positions, system, tapShiftLink]
  );

  useEffect(() => {
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      const it = interactionRef.current;
      const svg = svgRef.current;
      if (it?.pointerId != null && svg) {
        try {
          svg.releasePointerCapture(it.pointerId);
        } catch {
          /* ignore */
        }
      }
      interactionRef.current = null;
      setLiveBus(null);
      setWire(null);
      shiftPendingRef.current = null;
      setShiftArm((x) => x + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const placeTip = useCallback((e, lines) => {
    if (interactionRef.current) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const pad = 12;
    let x = e.clientX - rect.left + pad;
    let y = e.clientY - rect.top + pad;
    const tw = 280;
    const th = 120;
    if (x + tw > rect.width) x = e.clientX - rect.left - tw - pad;
    if (y + th > rect.height) y = e.clientY - rect.top - th - pad;
    setHoverTip({ x, y, lines });
  }, []);

  const clearTip = useCallback(() => setHoverTip(null), []);

  const lines = system.LINES || [];

  return (
    <div
      ref={frameRef}
      className="ps-diagram-frame"
      onPointerLeave={() => {
        if (!interactionRef.current) clearTip();
      }}
    >
      <svg
        ref={svgRef}
        className="ps-svg"
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="img"
        aria-label="One-line diagram"
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerCancel={onSvgPointerUp}
      >
        <rect width={size.w} height={size.h} className="ps-svg-bg" />

        {lines.map((ln, idx) => {
          const a = positions.get(Number(ln.from));
          const b = positions.get(Number(ln.to));
          if (!a || !b) return null;
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          const active = highlightLineIndex === idx;
          return (
            <g
              key={`${ln.from}-${ln.to}-${idx}`}
              className="ps-line-group"
              style={{ cursor: "help" }}
              onPointerEnter={(e) => placeTip(e, lineSpecLines(ln))}
              onPointerMove={(e) => placeTip(e, lineSpecLines(ln))}
              onPointerLeave={clearTip}
            >
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className="ps-line-hit"
                pointerEvents="stroke"
              />
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={active ? "ps-line ps-line-active" : "ps-line"}
                pointerEvents="none"
              />
              <text x={midX} y={midY - 6} className="ps-line-label" textAnchor="middle" pointerEvents="none">
                {ln.name || `${ln.from}–${ln.to}`}
              </text>
              <text x={midX} y={midY + 10} className="ps-line-z" textAnchor="middle" pointerEvents="none">
                r={num(ln.r)} x={num(ln.x)}
              </text>
            </g>
          );
        })}

      {wire ? (
        <line
          x1={wire.x1}
          y1={wire.y1}
          x2={wire.x2}
          y2={wire.y2}
          className="ps-wire-preview"
          pointerEvents="none"
        />
      ) : null}

        {collectBuses(system).map((bus) => {
          const p = positions.get(bus);
          if (!p) return null;
          const gen = (system.GENERATORS || []).find((g) => Number(g.bus) === bus);
          const load = (system.LOADS || []).find((l) => Number(l.bus) === bus);
          const isSlack = Boolean(gen && /slack/i.test(String(gen.name || "")));
          const G = BUS_GRAPHIC;
          const both = Boolean(gen && load);
          const lx = both ? -G.splitX : 0;
          const gx = both ? G.splitX : 0;
          const genR = isSlack ? G.genRSlack : G.genR;
          const loadY2 = load ? G.loadCy + G.loadR : 0;
          const genY2 = gen ? G.genCy - genR : 0;
          const sel = selectedBus === bus;
          const linkHint = shiftLinkFrom != null && shiftLinkFrom !== bus;

          return (
            <g
              key={bus}
              transform={`translate(${p.x},${p.y})`}
              className={sel ? "ps-node ps-node-selected" : "ps-node"}
              onPointerEnter={(e) => placeTip(e, busSpecLines(system, bus))}
              onPointerMove={(e) => placeTip(e, busSpecLines(system, bus))}
              onPointerLeave={clearTip}
            >
              <text y={-36} className="ps-bus-index" textAnchor="middle">
                Bus {bus}
              </text>

              <line
                x1={-G.barHalf}
                y1={0}
                x2={G.barHalf}
                y2={0}
                className="ps-busbar-hit"
                onPointerDown={(e) => {
                  clearTip();
                  onPointerDownBar(e, bus);
                }}
                style={{ cursor: shiftLinkFrom != null ? "cell" : "grab" }}
              />
              <line
                x1={-G.barHalf}
                y1={0}
                x2={G.barHalf}
                y2={0}
                className={`ps-busbar ${linkHint ? "ps-busbar-link" : ""}`}
                pointerEvents="none"
              />

              {load ? (
                <g>
                  <line
                    x1={lx}
                    y1={0}
                    x2={lx}
                    y2={loadY2}
                    className="ps-equip-stub"
                    pointerEvents="none"
                  />
                  <circle
                    cx={lx}
                    cy={G.loadCy}
                    r={G.loadR}
                    className={`ps-load-symbol${linkHint ? " ps-equip-link" : ""}`}
                    onPointerDown={(e) => {
                      clearTip();
                      onPointerDownEquip(e, bus, "load");
                    }}
                    style={{ cursor: shiftLinkFrom != null ? "cell" : "crosshair" }}
                  />
                  <text x={lx} y={G.loadCy - G.loadR - 8} className="ps-bus-id" textAnchor="middle">
                    L{bus}
                  </text>
                  {load.name ? (
                    <text x={lx} y={G.loadCy - G.loadR - 22} className="ps-bus-label" textAnchor="middle">
                      {load.name.length > 12 ? `${load.name.slice(0, 10)}…` : load.name}
                    </text>
                  ) : null}
                </g>
              ) : null}

              {gen ? (
                <g>
                  <line
                    x1={gx}
                    y1={0}
                    x2={gx}
                    y2={genY2}
                    className="ps-equip-stub"
                    pointerEvents="none"
                  />
                  <circle
                    cx={gx}
                    cy={G.genCy}
                    r={genR}
                    className={
                      isSlack
                        ? `ps-gen-symbol ps-bus-slack${linkHint ? " ps-equip-link" : ""}`
                        : `ps-gen-symbol ps-bus-gen${linkHint ? " ps-equip-link" : ""}`
                    }
                    onPointerDown={(e) => {
                      clearTip();
                      onPointerDownEquip(e, bus, "gen");
                    }}
                    style={{ cursor: shiftLinkFrom != null ? "cell" : "crosshair" }}
                  />
                  <text x={gx} y={G.genCy + genR + 14} className="ps-bus-id" textAnchor="middle">
                    {isSlack ? `S${bus}` : `G${bus}`}
                  </text>
                  {gen.name ? (
                    <text x={gx} y={G.genCy + genR + 28} className="ps-bus-label" textAnchor="middle">
                      {gen.name.length > 14 ? `${gen.name.slice(0, 12)}…` : gen.name}
                    </text>
                  ) : null}
                </g>
              ) : null}

              {!gen && !load ? (
                <text y={22} className="ps-bus-junction-hint" textAnchor="middle">
                  Junction
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hoverTip ? (
        <div
          className="ps-circuit-tooltip"
          style={{ left: hoverTip.x, top: hoverTip.y }}
          role="tooltip"
        >
          {hoverTip.lines.map((line, i) => (
            <div key={i} className={i === 0 ? "ps-circuit-tooltip-title" : "ps-circuit-tooltip-row"}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AppInner() {
  const [system, setSystem] = useState(() => structuredClone(DEFAULT_SYSTEM));
  const [jsonText, setJsonText] = useState(() => systemToPrettyJson(DEFAULT_SYSTEM));
  const [jsonError, setJsonError] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [highlightLineIndex, setHighlightLineIndex] = useState(null);

  const syncJsonFromSystem = useCallback((s) => {
    setJsonText(systemToPrettyJson(s));
    setJsonError("");
    setJsonDirty(false);
  }, []);

  const applyParsedSystem = useCallback(
    (next) => {
      setSystem(next);
      syncJsonFromSystem(next);
      setSelectedBus(null);
      setHighlightLineIndex(null);
    },
    [syncJsonFromSystem]
  );

  useEffect(() => {
    if (!jsonDirty) return;
    const t = window.setTimeout(() => {
      try {
        const next = parseSystemJson(jsonText);
        applyParsedSystem(next);
      } catch (e) {
        setJsonError(e?.message || String(e));
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [jsonText, jsonDirty, applyParsedSystem]);

  const resetDefault = useCallback(() => {
    applyParsedSystem(structuredClone(DEFAULT_SYSTEM));
  }, [applyParsedSystem]);

  const onBusDragEnd = useCallback((bus, nx, ny) => {
    setSystem((prev) => {
      const next = structuredClone(prev);
      if (!next.LAYOUT) next.LAYOUT = {};
      next.LAYOUT[String(bus)] = { nx, ny };
      setJsonText(systemToPrettyJson(next));
      setJsonError("");
      setJsonDirty(false);
      return next;
    });
  }, []);

  const addLineBetween = useCallback(
    (a, b) => {
      if (a === b) return;
      setSystem((prev) => {
        const exists = (prev.LINES || []).some(
          (ln) =>
            (Number(ln.from) === a && Number(ln.to) === b) ||
            (Number(ln.from) === b && Number(ln.to) === a)
        );
        if (exists) return prev;
        const next = structuredClone(prev);
        next.LINES.push({
          from: Math.min(a, b),
          to: Math.max(a, b),
          name: `Line ${a}-${b}`,
          r: 0.05,
          x: 0.1,
          b: 0.02,
        });
        setJsonText(systemToPrettyJson(next));
        setJsonError("");
        setJsonDirty(false);
        return next;
      });
    },
    []
  );

  const onWireComplete = useCallback(
    (fromBus, toBus) => {
      addLineBetween(fromBus, toBus);
    },
    [addLineBetween]
  );

  const updateGen = (i, patch) => {
    setSystem((prev) => {
      const next = structuredClone(prev);
      next.GENERATORS[i] = { ...next.GENERATORS[i], ...patch };
      setJsonText(systemToPrettyJson(next));
      setJsonError("");
      setJsonDirty(false);
      return next;
    });
  };

  const addGen = () => {
    const buses = collectBuses(system);
    const bus = buses.length ? Math.max(...buses) + 1 : 0;
    const next = structuredClone(system);
    next.GENERATORS.push({
      bus,
      name: `Gen ${next.GENERATORS.length + 1}`,
      Pmin: 0,
      Pmax: 100,
      a: 0.02,
      b: 20,
      vset: 1.0,
    });
    setSystem(next);
    syncJsonFromSystem(next);
    setSelectedBus(bus);
  };

  const removeGen = (i) => {
    const next = structuredClone(system);
    const b = next.GENERATORS[i]?.bus;
    next.GENERATORS.splice(i, 1);
    setSystem(next);
    syncJsonFromSystem(next);
    if (selectedBus === b) setSelectedBus(null);
  };

  const updateLoad = (i, patch) => {
    setSystem((prev) => {
      const next = structuredClone(prev);
      next.LOADS[i] = { ...next.LOADS[i], ...patch };
      setJsonText(systemToPrettyJson(next));
      setJsonError("");
      setJsonDirty(false);
      return next;
    });
  };

  const addLoad = () => {
    const buses = collectBuses(system);
    const bus = buses.length ? Math.max(...buses) + 1 : 0;
    const next = structuredClone(system);
    next.LOADS.push({
      bus,
      name: `Load ${String.fromCharCode(65 + next.LOADS.length - 1)}`,
      P: 40,
      Q: 15,
    });
    setSystem(next);
    syncJsonFromSystem(next);
    setSelectedBus(bus);
  };

  const removeLoad = (i) => {
    const next = structuredClone(system);
    const b = next.LOADS[i]?.bus;
    next.LOADS.splice(i, 1);
    setSystem(next);
    syncJsonFromSystem(next);
    if (selectedBus === b) setSelectedBus(null);
  };

  const updateLine = (i, patch) => {
    setSystem((prev) => {
      const next = structuredClone(prev);
      next.LINES[i] = { ...next.LINES[i], ...patch };
      setJsonText(systemToPrettyJson(next));
      setJsonError("");
      setJsonDirty(false);
      return next;
    });
  };

  const addLine = () => {
    const buses = collectBuses(system);
    if (buses.length < 2) return;
    const next = structuredClone(system);
    next.LINES.push({
      from: buses[0],
      to: buses[1],
      name: `Line ${buses[0]}-${buses[1]}`,
      r: 0.05,
      x: 0.1,
      b: 0.02,
    });
    setSystem(next);
    syncJsonFromSystem(next);
    setHighlightLineIndex(next.LINES.length - 1);
  };

  const removeLine = (i) => {
    const next = structuredClone(system);
    next.LINES.splice(i, 1);
    setSystem(next);
    syncJsonFromSystem(next);
    if (highlightLineIndex === i) setHighlightLineIndex(null);
  };

  const busList = useMemo(() => collectBuses(system), [system]);

  return (
    <div className="page ps-page">
      <header className="topbar ps-site-header">
        <div className="topbarInner ps-site-header-inner">
          <h1 className="ps-site-title">Agentic Veragrid Evaluation</h1>
        </div>
      </header>

      <main className="ps-workspace">
        <div className="ps-layout-grid">
          <div className="ps-col-design">
            <section className="ps-panel ps-design-panel">
              <div className="ps-design-head">
                <h2 className="ps-section-heading">Designing the circuit diagram</h2>
                <div className="ps-toolbar-inline" role="toolbar" aria-label="Model actions">
                  <button type="button" className="ps-btn-accent ps-btn-reset" onClick={resetDefault}>
                    Reset
                  </button>
                  <span className="ps-toolbar-inline-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="ps-btn-accent ps-btn-reload"
                    onClick={() => syncJsonFromSystem(system)}
                    disabled={!jsonDirty}
                  >
                    Reload
                  </button>
                </div>
              </div>
              <div className="ps-diagram-panel ps-diagram-hero">
                <CircuitDiagram
                  system={system}
                  onBusDragEnd={onBusDragEnd}
                  onWireComplete={onWireComplete}
                  selectedBus={selectedBus}
                  onSelectBus={setSelectedBus}
                  highlightLineIndex={highlightLineIndex}
                />
                <div className="ps-legend" aria-label="Legend">
                  <span>
                    <i className="ps-dot ps-dot-slack" /> Slack
                  </span>
                  <span>
                    <i className="ps-dot ps-dot-gen" /> Gen
                  </span>
                  <span>
                    <i className="ps-dot ps-dot-load" /> Load
                  </span>
                  <span className="ps-legend-bar" />
                  <span>Bus bar</span>
                  <span>
                    <i className="ps-dot ps-dot-bus" /> Junction only
                  </span>
                </div>
              </div>

              <div className="ps-json-section">
                <h3 className="ps-subsection-heading">JSON model</h3>
                <p className="ps-json-hint">Valid JSON is applied automatically after you pause typing. Use Reload to discard JSON edits.</p>
                <textarea
                  className="ps-json"
                  spellCheck={false}
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonDirty(true);
                    setJsonError("");
                  }}
                />
                {jsonError ? <div className="ps-json-error">{jsonError}</div> : null}
              </div>
            </section>
          </div>

          <aside className="ps-col-tables" aria-label="Equipment and branch tables">
            <h2 className="ps-section-heading ps-section-heading-tables">Generators, loads &amp; lines</h2>
            <div className="ps-tables-stack">
          <section className="ps-panel">
            <div className="ps-panel-head-bar ps-panel-head-bar-tight">
              <h2 className="ps-panel-title">Generators</h2>
              <button type="button" className="btn btnSecondary btnCompact" onClick={addGen}>
                Add row
              </button>
            </div>
            <div className="ps-table-wrap">
              <table className="ps-table">
                <thead>
                  <tr>
                    <th>Bus</th>
                    <th>Name</th>
                    <th>Pmin</th>
                    <th>Pmax</th>
                    <th>a</th>
                    <th>b</th>
                    <th>vset</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(system.GENERATORS || []).map((g, i) => (
                    <tr
                      key={i}
                      className={selectedBus === Number(g.bus) ? "ps-row-selected" : undefined}
                    >
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={g.bus}
                          onChange={(e) => updateGen(i, { bus: num(e.target.value, g.bus) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input"
                          value={g.name}
                          onChange={(e) => updateGen(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={g.Pmin}
                          onChange={(e) => updateGen(i, { Pmin: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={g.Pmax}
                          onChange={(e) => updateGen(i, { Pmax: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.001"
                          value={g.a}
                          onChange={(e) => updateGen(i, { a: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.1"
                          value={g.b}
                          onChange={(e) => updateGen(i, { b: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.01"
                          value={g.vset}
                          onChange={(e) => updateGen(i, { vset: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <button type="button" className="ps-icon-btn" onClick={() => removeGen(i)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ps-panel">
            <div className="ps-panel-head-bar ps-panel-head-bar-tight">
              <h2 className="ps-panel-title">Loads</h2>
              <button type="button" className="btn btnSecondary btnCompact" onClick={addLoad}>
                Add row
              </button>
            </div>
            <div className="ps-table-wrap">
              <table className="ps-table">
                <thead>
                  <tr>
                    <th>Bus</th>
                    <th>Name</th>
                    <th>P</th>
                    <th>Q</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(system.LOADS || []).map((l, i) => (
                    <tr
                      key={i}
                      className={selectedBus === Number(l.bus) ? "ps-row-selected" : undefined}
                    >
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={l.bus}
                          onChange={(e) => updateLoad(i, { bus: num(e.target.value, l.bus) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input"
                          value={l.name}
                          onChange={(e) => updateLoad(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={l.P}
                          onChange={(e) => updateLoad(i, { P: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          value={l.Q}
                          onChange={(e) => updateLoad(i, { Q: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <button type="button" className="ps-icon-btn" onClick={() => removeLoad(i)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ps-panel">
            <div className="ps-panel-head-bar ps-panel-head-bar-tight">
              <h2 className="ps-panel-title">Lines</h2>
              <button type="button" className="btn btnSecondary btnCompact" onClick={addLine}>
                Add row
              </button>
            </div>
            <div className="ps-table-wrap">
              <table className="ps-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Name</th>
                    <th>r</th>
                    <th>x</th>
                    <th>b</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(system.LINES || []).map((ln, i) => (
                    <tr
                      key={i}
                      className={highlightLineIndex === i ? "ps-row-selected" : undefined}
                      onClick={(e) => {
                        if (e.target.closest("button, input, select, textarea, label")) return;
                        setHighlightLineIndex(i);
                      }}
                    >
                      <td>
                        <select
                          className="ps-select"
                          value={ln.from}
                          onChange={(e) => updateLine(i, { from: num(e.target.value) })}
                        >
                          {busList.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className="ps-select"
                          value={ln.to}
                          onChange={(e) => updateLine(i, { to: num(e.target.value) })}
                        >
                          {busList.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="ps-input"
                          value={ln.name}
                          onChange={(e) => updateLine(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.001"
                          value={ln.r}
                          onChange={(e) => updateLine(i, { r: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.001"
                          value={ln.x}
                          onChange={(e) => updateLine(i, { x: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="ps-input ps-input-narrow"
                          type="number"
                          step="0.001"
                          value={ln.b}
                          onChange={(e) => updateLine(i, { b: num(e.target.value) })}
                        />
                      </td>
                      <td>
                        <button type="button" className="ps-icon-btn" onClick={() => removeLine(i)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
            </div>
          </aside>
        </div>
      </main>

    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
