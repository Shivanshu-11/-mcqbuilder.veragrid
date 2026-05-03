import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
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

/** Path from site root (e.g. /api/...) joined with Vite base — required for GitHub Pages. */
function resolveAppPath(pathFromRoot) {
  const tail = pathFromRoot.startsWith("/") ? pathFromRoot.slice(1) : pathFromRoot;
  return `${import.meta.env.BASE_URL}${tail}`;
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

const DEFAULT_MODEL_PROMPT = `I am solving an AC optimal power flow problem with a simple 3-bus radial circuit.

Bus 1 is the slack/reference bus with 1 generator that has a voltage setpoint of 1.0 pu.

Bus 2 is a load bus with a load of P=40 MW and Q=20 MVAr.

Bus 3 is a load bus with a load of P=25 MW and Q=15 MVAr.

Bus 1 and Bus 2 are connected by Line 1-2 with r=0.05, x=0.11, b=0.02.

Bus 2 and Bus 3 are connected by Line 2-3 with r=0.04, x=0.09, b=0.02.

Answer each question with ONLY the letter (A, B, C, or D). Do not include any explanation.`;

const MODEL_GROUPS = [
  {
    label: "OpenAI · GPT-5.5",
    options: ["gpt-5.5", "gpt-5.5-pro"],
  },
  {
    label: "OpenAI · GPT-5.4",
    options: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    label: "OpenAI · GPT-5",
    options: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
  },
  {
    label: "OpenAI · GPT-4.1",
    options: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"],
  },
  {
    label: "OpenAI · GPT-4o",
    options: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    label: "OpenAI · Reasoning (o-series)",
    options: ["o3-pro", "o3", "o3-mini", "o1", "o1-mini"],
  },
  {
    label: "Anthropic · Claude 4 family",
    options: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
    ],
  },
  {
    label: "Anthropic · Claude 3 family",
    options: [
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    label: "Cursor · Composer (via cursor-agent CLI)",
    options: [
      "cursor:auto",
      "cursor:composer-2",
      "cursor:composer-2-fast",
      "cursor:composer-1.5",
      "cursor:composer-1",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5.5",
    options: [
      "cursor:gpt-5.5",
      "cursor:gpt-5.5-fast",
      "cursor:gpt-5.5-high",
      "cursor:gpt-5.5-high-fast",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5.4",
    options: [
      "cursor:gpt-5.4",
      "cursor:gpt-5.4-mini",
      "cursor:gpt-5.4-nano",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5.3 Codex",
    options: [
      "cursor:gpt-5.3-codex",
      "cursor:gpt-5.3-codex-low",
      "cursor:gpt-5.3-codex-high",
      "cursor:gpt-5.3-codex-xhigh",
      "cursor:gpt-5.3-codex-fast",
      "cursor:gpt-5.3-codex-low-fast",
      "cursor:gpt-5.3-codex-high-fast",
      "cursor:gpt-5.3-codex-xhigh-fast",
      "cursor:gpt-5.3-codex-spark-preview",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5.2",
    options: [
      "cursor:gpt-5.2",
      "cursor:gpt-5.2-high",
      "cursor:gpt-5.2-codex",
      "cursor:gpt-5.2-codex-low",
      "cursor:gpt-5.2-codex-high",
      "cursor:gpt-5.2-codex-xhigh",
      "cursor:gpt-5.2-codex-fast",
      "cursor:gpt-5.2-codex-low-fast",
      "cursor:gpt-5.2-codex-high-fast",
      "cursor:gpt-5.2-codex-xhigh-fast",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5.1",
    options: [
      "cursor:gpt-5.1-high",
      "cursor:gpt-5.1-codex",
      "cursor:gpt-5.1-codex-max",
      "cursor:gpt-5.1-codex-max-high",
      "cursor:gpt-5.1-codex-mini",
    ],
  },
  {
    label: "Cursor · OpenAI GPT-5",
    options: [
      "cursor:gpt-5",
      "cursor:gpt-5-mini",
      "cursor:gpt-5-codex",
      "cursor:gpt-5-fast",
      "cursor:gpt-5-high",
      "cursor:gpt-5-high-fast",
      "cursor:gpt-5-low-fast",
    ],
  },
  {
    label: "Cursor · Anthropic Claude Opus",
    options: [
      "cursor:opus-4.7",
      "cursor:opus-4.6",
      "cursor:opus-4.6-thinking",
      "cursor:opus-4.6-fast",
      "cursor:opus-4.5",
      "cursor:opus-4.5-thinking",
    ],
  },
  {
    label: "Cursor · Anthropic Claude Sonnet",
    options: [
      "cursor:sonnet-4.6",
      "cursor:sonnet-4.6-thinking",
      "cursor:sonnet-4.5",
      "cursor:sonnet-4.5-thinking",
      "cursor:sonnet-4",
      "cursor:sonnet-4-1m",
    ],
  },
  {
    label: "Cursor · Anthropic Claude Haiku",
    options: [
      "cursor:haiku-4.5",
    ],
  },
  {
    label: "Cursor · Google Gemini",
    options: [
      "cursor:gemini-3.1-pro",
      "cursor:gemini-3-pro",
      "cursor:gemini-3-pro-image-preview",
      "cursor:gemini-3-flash",
      "cursor:gemini-2.5-flash",
    ],
  },
  {
    label: "Cursor · xAI / Moonshot",
    options: [
      "cursor:grok",
      "cursor:grok-4.20",
      "cursor:kimi-k2.5",
    ],
  },
];
const DEFAULT_EVAL_MODEL = MODEL_GROUPS[0].options[0];

const ADVERSARIAL_MODEL_OPTIONS = [
  {
    label: "Anthropic · Claude (latest)",
    options: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  {
    label: "Anthropic · Claude (still supported)",
    options: [
      "claude-opus-4-6",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-opus-4-1",
    ],
  },
  {
    label: "OpenAI · GPT-5 family",
    options: [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
    ],
  },
  {
    label: "OpenAI · GPT-4 family",
    options: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
    ],
  },
];
const DEFAULT_ADVERSARIAL_GEN_MODEL = "claude-opus-4-7";
const DEFAULT_ADVERSARIAL_SOLVER_MODEL = "claude-haiku-4-5";

function adversarialProviderOf(model) {
  const lower = String(model || "").toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return "openai";
  }
  return "unknown";
}
const EVAL_MODES = [
  { value: "no_tool_use", label: "No-Tool Use Mode" },
  { value: "agent", label: "Agent Mode" },
];

function providerFromModel(model) {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("cursor:") || m.startsWith("cursor-")) return "cursor";
  if (m.startsWith("claude")) return "claude";
  return "openai";
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

function MCQPage({
  mcqData,
  mcqStatus,
  mcqError,
  mcqDiagnostics,
  onGenerateMcqs,
  onAddManualMcq,
  hasOpfResults,
  claudeApiKey,
  onClaudeApiKeyChange,
  openAiApiKey,
  onOpenAiApiKeyChange,
}) {
  const [easyCount, setEasyCount] = useState(50);
  const [mediumCount, setMediumCount] = useState(50);
  const [hardCount, setHardCount] = useState(50);
  const [difficultyFilter, setDifficultyFilter] = useState("All");
  const [manualQuestion, setManualQuestion] = useState("");
  const [manualA, setManualA] = useState("");
  const [manualB, setManualB] = useState("");
  const [manualC, setManualC] = useState("");
  const [manualD, setManualD] = useState("");
  const [manualCorrect, setManualCorrect] = useState("A");
  const [manualExplanation, setManualExplanation] = useState("");
  const [manualError, setManualError] = useState("");

  const [generationMode, setGenerationMode] = useState("templates");
  const [genModel, setGenModel] = useState(DEFAULT_ADVERSARIAL_GEN_MODEL);
  const [solverModel, setSolverModel] = useState(DEFAULT_ADVERSARIAL_SOLVER_MODEL);
  const [rounds, setRounds] = useState(2);
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const questions = mcqData?.questions || [];
  const metadata = mcqData?.metadata || null;
  const manualCount = questions.filter(
    (q) => String(q.difficulty || "").toLowerCase() === "manually added"
  ).length;
  const filteredQuestions =
    difficultyFilter === "All"
      ? questions
      : questions.filter((q) => String(q.difficulty || "").toLowerCase() === difficultyFilter.toLowerCase());

  const triggerGeneration = () => {
    onGenerateMcqs({
      mode: generationMode,
      easy: Math.max(0, Number(easyCount) || 0),
      medium: Math.max(0, Number(mediumCount) || 0),
      hard: Math.max(0, Number(hardCount) || 0),
      genModel,
      solverModel,
      rounds: Math.max(1, Math.min(5, Number(rounds) || 1)),
    });
  };

  const genProvider = adversarialProviderOf(genModel);
  const solverProvider = adversarialProviderOf(solverModel);
  const needsAnthropicKey = generationMode === "adversarial" && (genProvider === "anthropic" || solverProvider === "anthropic");
  const needsOpenAiKey = generationMode === "adversarial" && (genProvider === "openai" || solverProvider === "openai");
  const missingClaudeKey = needsAnthropicKey && !(claudeApiKey || "").trim();
  const missingOpenAiKey = needsOpenAiKey && !(openAiApiKey || "").trim();
  const adversarialReady = generationMode !== "adversarial" || (!missingClaudeKey && !missingOpenAiKey);

  const addManualQuestion = () => {
    if (!manualQuestion.trim()) {
      setManualError("Please enter a question.");
      return;
    }
    if (!manualA.trim() || !manualB.trim() || !manualC.trim() || !manualD.trim()) {
      setManualError("Please fill all four options.");
      return;
    }
    const options = {
      A: manualA.trim(),
      B: manualB.trim(),
      C: manualC.trim(),
      D: manualD.trim(),
    };
    const correctValue = options[manualCorrect] || "";
    if (!correctValue) {
      setManualError("Please choose a valid correct option.");
      return;
    }

    onAddManualMcq({
      question: manualQuestion.trim(),
      options,
      correct_answer: manualCorrect,
      correct_value: correctValue,
      explanation: manualExplanation.trim(),
    });
    setManualQuestion("");
    setManualA("");
    setManualB("");
    setManualC("");
    setManualD("");
    setManualCorrect("A");
    setManualExplanation("");
    setManualError("");
  };

  return (
    <div className="ps-page-content">
      <h2 className="ps-page-title">MCQ Questions</h2>
      <section className="ps-panel ps-design-panel">
        <div className="ps-mcq-mode-row" role="radiogroup" aria-label="MCQ generation mode">
          <label className={`ps-mcq-mode-card${generationMode === "templates" ? " ps-mcq-mode-card--active" : ""}`}>
            <input
              type="radio"
              name="mcq-mode"
              value="templates"
              checked={generationMode === "templates"}
              onChange={() => setGenerationMode("templates")}
            />
            <div>
              <strong>Templates (instant)</strong>
              <p>Numbers come straight from your OPF JSON via deterministic recipes. No LLM, no API key.</p>
            </div>
          </label>
          <label className={`ps-mcq-mode-card${generationMode === "adversarial" ? " ps-mcq-mode-card--active" : ""}`}>
            <input
              type="radio"
              name="mcq-mode"
              value="adversarial"
              checked={generationMode === "adversarial"}
              onChange={() => setGenerationMode("adversarial")}
            />
            <div>
              <strong>Adversarial (LLM, slower)</strong>
              <p>Runs the Generator → Solver → Arbiter loop on Claude. Uses your Anthropic API key. Several minutes.</p>
            </div>
          </label>
        </div>

        {generationMode === "adversarial" ? (
          <div className="ps-mcq-adversarial-row">
            <label className="ps-mcq-input-group">
              <span>Generator model</span>
              <select
                className="ps-select"
                value={genModel}
                onChange={(e) => setGenModel(e.target.value)}
              >
                {ADVERSARIAL_MODEL_OPTIONS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="ps-mcq-input-group">
              <span>Solver model</span>
              <select
                className="ps-select"
                value={solverModel}
                onChange={(e) => setSolverModel(e.target.value)}
              >
                {ADVERSARIAL_MODEL_OPTIONS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="ps-mcq-input-group">
              <span>Rounds</span>
              <input
                className="ps-input ps-input-narrow"
                type="number"
                min="1"
                max="5"
                value={rounds}
                onChange={(e) => setRounds(e.target.value)}
              />
            </label>
            {needsAnthropicKey ? (
              <label className="ps-mcq-input-group ps-mcq-input-wide">
                <span>Anthropic API key (sk-ant-…)</span>
                <div className="ps-mcq-apikey-row">
                  <input
                    className="ps-input"
                    type={showClaudeKey ? "text" : "password"}
                    value={claudeApiKey}
                    onChange={(e) => onClaudeApiKeyChange(e.target.value)}
                    placeholder="sk-ant-…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="ps-btn-ghost ps-btn-tiny"
                    onClick={() => setShowClaudeKey((v) => !v)}
                  >
                    {showClaudeKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
            ) : null}
            {needsOpenAiKey ? (
              <label className="ps-mcq-input-group ps-mcq-input-wide">
                <span>OpenAI API key (sk-…)</span>
                <div className="ps-mcq-apikey-row">
                  <input
                    className="ps-input"
                    type={showOpenAiKey ? "text" : "password"}
                    value={openAiApiKey}
                    onChange={(e) => onOpenAiApiKeyChange(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="ps-btn-ghost ps-btn-tiny"
                    onClick={() => setShowOpenAiKey((v) => !v)}
                  >
                    {showOpenAiKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
            ) : null}
            <p className="ps-mcq-adversarial-note">
              Tip: pick a strong Generator (e.g. <code>claude-opus-4-7</code> or <code>gpt-5.5</code>) paired with a
              weaker, faster Solver (e.g. <code>claude-haiku-4-5</code> or <code>gpt-4o-mini</code>) — the larger the
              capability gap, the more questions get Promoted. You can also mix providers (Claude Generator vs GPT
              Solver and vice versa).
            </p>
          </div>
        ) : null}

        <div className="ps-mcq-controls">
          <div className="ps-mcq-counts">
            <label className="ps-mcq-input-group">
              <span>Easy</span>
              <input
                className="ps-input ps-input-narrow"
                type="number"
                min="0"
                value={easyCount}
                onChange={(e) => setEasyCount(e.target.value)}
              />
            </label>
            <label className="ps-mcq-input-group">
              <span>Medium</span>
              <input
                className="ps-input ps-input-narrow"
                type="number"
                min="0"
                value={mediumCount}
                onChange={(e) => setMediumCount(e.target.value)}
              />
            </label>
            <label className="ps-mcq-input-group">
              <span>Hard</span>
              <input
                className="ps-input ps-input-narrow"
                type="number"
                min="0"
                value={hardCount}
                onChange={(e) => setHardCount(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="ps-btn-accent ps-btn-generate"
            onClick={triggerGeneration}
            disabled={mcqStatus === "loading" || !hasOpfResults || !adversarialReady}
            title={
              !hasOpfResults
                ? "Run OPF first in Designing Circuit Diagram"
                : !adversarialReady
                  ? `Adversarial mode needs ${
                      missingClaudeKey && missingOpenAiKey
                        ? "both Anthropic and OpenAI"
                        : missingClaudeKey
                          ? "an Anthropic"
                          : "an OpenAI"
                    } API key`
                  : generationMode === "adversarial"
                    ? "Run Generator → Solver → Arbiter loop"
                    : "Generate MCQ questions"
            }
          >
            {mcqStatus === "loading"
              ? generationMode === "adversarial"
                ? "Running adversarial loop…"
                : "Generating MCQs..."
              : generationMode === "adversarial"
                ? "Run adversarial generation"
                : "Generate MCQs"}
          </button>
        </div>
        {generationMode === "adversarial" && !adversarialReady ? (
          <p className="ps-error-inline">
            Add your{" "}
            {missingClaudeKey && missingOpenAiKey
              ? "Anthropic and OpenAI"
              : missingClaudeKey
                ? "Anthropic"
                : "OpenAI"}{" "}
            API key{missingClaudeKey && missingOpenAiKey ? "s" : ""} above to run the adversarial loop.
          </p>
        ) : null}

        <div className="ps-mcq-filter-row">
          <label className="ps-mcq-input-group">
            <span>Show difficulty</span>
            <select
              className="ps-select"
              value={difficultyFilter}
              onChange={(e) => setDifficultyFilter(e.target.value)}
            >
              <option value="All">All</option>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
              <option value="manually added">Manually Added</option>
            </select>
          </label>
        </div>

        <div className="ps-mcq-manual-form">
          <h3 className="ps-subsection-heading">Add MCQ Manually</h3>
          <div className="ps-mcq-manual-grid">
            <label className="ps-mcq-input-group ps-mcq-input-wide">
              <span>Question</span>
              <input
                className="ps-input"
                value={manualQuestion}
                onChange={(e) => setManualQuestion(e.target.value)}
                placeholder="Enter your question"
              />
            </label>
            <label className="ps-mcq-input-group">
              <span>Option A</span>
              <input className="ps-input" value={manualA} onChange={(e) => setManualA(e.target.value)} />
            </label>
            <label className="ps-mcq-input-group">
              <span>Option B</span>
              <input className="ps-input" value={manualB} onChange={(e) => setManualB(e.target.value)} />
            </label>
            <label className="ps-mcq-input-group">
              <span>Option C</span>
              <input className="ps-input" value={manualC} onChange={(e) => setManualC(e.target.value)} />
            </label>
            <label className="ps-mcq-input-group">
              <span>Option D</span>
              <input className="ps-input" value={manualD} onChange={(e) => setManualD(e.target.value)} />
            </label>
            <label className="ps-mcq-input-group">
              <span>Correct Option</span>
              <select className="ps-select" value={manualCorrect} onChange={(e) => setManualCorrect(e.target.value)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
              </select>
            </label>
            <label className="ps-mcq-input-group ps-mcq-input-wide">
              <span>Explanation (optional)</span>
              <input
                className="ps-input"
                value={manualExplanation}
                onChange={(e) => setManualExplanation(e.target.value)}
                placeholder="Why this answer is correct"
              />
            </label>
          </div>
          {manualError ? <p className="ps-error-inline">{manualError}</p> : null}
          <button type="button" className="ps-btn-accent ps-btn-run" onClick={addManualQuestion}>
            Add Manual MCQ
          </button>
        </div>

        {!hasOpfResults ? (
          <p className="ps-placeholder-text">Run OPF from Designing Circuit Diagram before generating MCQs.</p>
        ) : null}

        {mcqStatus === "loading" ? (
          <p className="ps-placeholder-text">
            {generationMode === "adversarial"
              ? "Running Generator → Solver → Arbiter loop on Claude. This can take several minutes…"
              : "Generating MCQ questions..."}
          </p>
        ) : null}
        {mcqError ? <p className="ps-error-inline">{mcqError}</p> : null}
        {mcqDiagnostics && (mcqDiagnostics.stderr || mcqDiagnostics.stdout) ? (
          <details className="ps-mcq-diagnostics" open={mcqStatus === "error"}>
            <summary>
              Adversarial pipeline diagnostics
              {mcqDiagnostics.genModel ? ` · gen: ${mcqDiagnostics.genModel}` : ""}
              {mcqDiagnostics.solverModel ? ` · solver: ${mcqDiagnostics.solverModel}` : ""}
            </summary>
            {mcqDiagnostics.stderr ? (
              <>
                <p className="ps-mcq-diagnostics-label">stderr</p>
                <pre className="ps-mcq-diagnostics-pre">{mcqDiagnostics.stderr}</pre>
              </>
            ) : null}
            {mcqDiagnostics.stdout ? (
              <>
                <p className="ps-mcq-diagnostics-label">stdout</p>
                <pre className="ps-mcq-diagnostics-pre">{mcqDiagnostics.stdout}</pre>
              </>
            ) : null}
          </details>
        ) : null}

        {filteredQuestions.length > 0 ? (
          <div className="ps-mcq-list">
            <div className="ps-mcq-meta">
              <span>{filteredQuestions.length} shown (total {metadata?.total_questions || questions.length})</span>
              <span>
                Easy: {metadata?.easy_count || 0} | Medium: {metadata?.medium_count || 0} | Hard:{" "}
                {metadata?.hard_count || 0} | Manually Added: {manualCount}
              </span>
            </div>

            {filteredQuestions.map((q) => (
              <article key={q.id} className="ps-mcq-item">
                <h3 className="ps-mcq-question">
                  Q{q.id}. {q.question}
                </h3>
                <p className="ps-mcq-difficulty">Difficulty: {q.difficulty || "-"}</p>
                <ul className="ps-mcq-options">
                  {Object.entries(q.options || {}).map(([key, value]) => (
                    <li key={key}>
                      <strong>{key}.</strong> {value}
                    </li>
                  ))}
                </ul>
                <p className="ps-mcq-answer">
                  Answer: {q.correct_answer} ({q.correct_value})
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="ps-mcq-placeholder">
            <p className="ps-placeholder-text">
              No MCQs for the selected filter yet. Generate MCQs from this panel.
            </p>
          </div>
        )}
      </section>

      <section className="ps-panel ps-mcq-figure">
        <h3 className="ps-subsection-heading">How MCQs Are Built</h3>
        <p className="ps-mcq-figure-intro">
          The diagram is the <strong>adversarial</strong> loop (two LLM “brains” + a code judge).{" "}
          <strong>Templates</strong> mode skips the LLMs and just reads numbers from your OPF JSON
          via fixed recipes (instant). <strong>Adversarial</strong> mode actually runs this diagram—pick the
          Generator/Solver Claude models above, paste your Anthropic API key, then click{" "}
          <em>Run adversarial generation</em>; expect a few minutes per round.
        </p>

        <svg
          className="ps-mcq-figure-svg"
          viewBox="0 0 1000 480"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="GAN-style MCQ pipeline: OPF dataset feeds a Generator LLM that crafts trap MCQs; a Solver LLM answers them blind; the Arbiter scales judge each answer and split the output into a Promoted set (KEEP, fooled the Solver) and a Discarded set (DROP, too easy); the Arbiter sends trap-hint feedback back to the Generator."
        >
          <defs>
            <marker id="ps-ah-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#475569" />
            </marker>
            <marker id="ps-ah-keep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#16a34a" />
            </marker>
            <marker id="ps-ah-drop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
            </marker>
            <marker id="ps-ah-feedback" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#2f6bff" />
            </marker>
          </defs>

          {/* === DATASET (database cylinders) === */}
          <g>
            <rect x="20" y="170" width="140" height="120" rx="14" ry="14" fill="#e0f2fe" stroke="#0284c7" strokeWidth="2" />
            <g transform="translate(90 215)">
              <ellipse cx="0" cy="-22" rx="32" ry="7" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
              <path d="M -32,-22 L -32,-8 A 32 7 0 0 0 32,-8 L 32,-22" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
              <ellipse cx="0" cy="-8" rx="32" ry="7" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
              <path d="M -32,-8 L -32,6 A 32 7 0 0 0 32,6 L 32,-8" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
              <ellipse cx="0" cy="6" rx="32" ry="7" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
              <path d="M -32,6 L -32,20 A 32 7 0 0 0 32,20 L 32,6" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
              <ellipse cx="0" cy="20" rx="32" ry="7" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
            </g>
            <text x="90" y="278" textAnchor="middle" fontSize="14" fontWeight="700" fill="#0c4a6e">OPF Dataset</text>
          </g>

          {/* === GENERATOR (brain + trap badge) === */}
          <g>
            <rect x="200" y="170" width="140" height="120" rx="14" ry="14" fill="#fce7f3" stroke="#db2777" strokeWidth="2" />
            <g transform="translate(270 220)">
              <path d="M -28,-5 C -28,-15 -20,-22 -10,-20 C -8,-26 6,-26 8,-20 C 18,-22 26,-15 26,-5 C 32,-2 32,8 26,12 C 26,20 16,24 10,20 C 6,26 -6,26 -10,20 C -16,24 -26,20 -26,12 C -32,8 -32,-2 -28,-5 Z" fill="#fbcfe8" stroke="#831843" strokeWidth="2" />
              <line x1="0" y1="-22" x2="0" y2="22" stroke="#831843" strokeWidth="1.5" />
              <path d="M -18,-12 Q -14,-6 -18,0" fill="none" stroke="#831843" strokeWidth="1.2" />
              <path d="M -18,4 Q -14,10 -18,16" fill="none" stroke="#831843" strokeWidth="1.2" />
              <path d="M 18,-12 Q 14,-6 18,0" fill="none" stroke="#831843" strokeWidth="1.2" />
              <path d="M 18,4 Q 14,10 18,16" fill="none" stroke="#831843" strokeWidth="1.2" />
            </g>
            <g>
              <circle cx="312" cy="195" r="12" fill="#fef2f2" stroke="#dc2626" strokeWidth="2" />
              <text x="312" y="200" textAnchor="middle" fontSize="15" fontWeight="900" fill="#dc2626">!</text>
            </g>
            <text x="270" y="278" textAnchor="middle" fontSize="14" fontWeight="700" fill="#831843">Generator</text>
          </g>

          {/* === SOLVER (brain + question badge) === */}
          <g>
            <rect x="380" y="170" width="140" height="120" rx="14" ry="14" fill="#fef3c7" stroke="#d97706" strokeWidth="2" />
            <g transform="translate(450 220)">
              <path d="M -28,-5 C -28,-15 -20,-22 -10,-20 C -8,-26 6,-26 8,-20 C 18,-22 26,-15 26,-5 C 32,-2 32,8 26,12 C 26,20 16,24 10,20 C 6,26 -6,26 -10,20 C -16,24 -26,20 -26,12 C -32,8 -32,-2 -28,-5 Z" fill="#fde68a" stroke="#7c2d12" strokeWidth="2" />
              <line x1="0" y1="-22" x2="0" y2="22" stroke="#7c2d12" strokeWidth="1.5" />
              <path d="M -18,-12 Q -14,-6 -18,0" fill="none" stroke="#7c2d12" strokeWidth="1.2" />
              <path d="M -18,4 Q -14,10 -18,16" fill="none" stroke="#7c2d12" strokeWidth="1.2" />
              <path d="M 18,-12 Q 14,-6 18,0" fill="none" stroke="#7c2d12" strokeWidth="1.2" />
              <path d="M 18,4 Q 14,10 18,16" fill="none" stroke="#7c2d12" strokeWidth="1.2" />
            </g>
            <g>
              <circle cx="492" cy="195" r="12" fill="#fffbeb" stroke="#d97706" strokeWidth="2" />
              <text x="492" y="200" textAnchor="middle" fontSize="15" fontWeight="900" fill="#d97706">?</text>
            </g>
            <text x="450" y="278" textAnchor="middle" fontSize="14" fontWeight="700" fill="#7c2d12">Solver</text>
          </g>

          {/* === ARBITER (scales of justice) === */}
          <g>
            <rect x="560" y="170" width="140" height="120" rx="14" ry="14" fill="#dcfce7" stroke="#16a34a" strokeWidth="2" />
            <g transform="translate(630 222)">
              <line x1="0" y1="-28" x2="0" y2="34" stroke="#14532d" strokeWidth="3" />
              <circle cx="0" cy="-28" r="3.5" fill="#14532d" />
              <rect x="-20" y="34" width="40" height="5" rx="1.5" fill="#14532d" />
              <line x1="-32" y1="-16" x2="32" y2="-16" stroke="#14532d" strokeWidth="3" />
              <line x1="-32" y1="-16" x2="-32" y2="-2" stroke="#14532d" strokeWidth="1.5" />
              <line x1="32" y1="-16" x2="32" y2="-2" stroke="#14532d" strokeWidth="1.5" />
              <ellipse cx="-32" cy="2" rx="18" ry="5" fill="#bbf7d0" stroke="#16a34a" strokeWidth="1.5" />
              <text x="-32" y="-3" textAnchor="middle" fontSize="14" fontWeight="900" fill="#16a34a">✓</text>
              <ellipse cx="32" cy="2" rx="18" ry="5" fill="#fecaca" stroke="#dc2626" strokeWidth="1.5" />
              <text x="32" y="-3" textAnchor="middle" fontSize="14" fontWeight="900" fill="#dc2626">✗</text>
            </g>
            <text x="630" y="278" textAnchor="middle" fontSize="14" fontWeight="700" fill="#14532d">Arbiter</text>
          </g>

          {/* === PROMOTED (shield with checkmark + difficulty chips) === */}
          <g>
            <rect x="800" y="40" width="180" height="120" rx="14" ry="14" fill="#ede9fe" stroke="#6d28d9" strokeWidth="2" />
            <g transform="translate(845 95)">
              <path d="M -22,-30 L 22,-30 L 22,5 Q 22,28 0,40 Q -22,28 -22,5 Z" fill="#ddd6fe" stroke="#6d28d9" strokeWidth="2" />
              <path d="M -12,3 L -2,13 L 14,-8" fill="none" stroke="#6d28d9" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            <g>
              <rect x="895" y="65" width="70" height="20" rx="10" fill="#d1fae5" stroke="#10b981" strokeWidth="1.5" />
              <text x="930" y="79" textAnchor="middle" fontSize="11" fontWeight="700" fill="#065f46">Easy</text>
              <rect x="895" y="91" width="70" height="20" rx="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="1.5" />
              <text x="930" y="105" textAnchor="middle" fontSize="11" fontWeight="700" fill="#7c2d12">Medium</text>
              <rect x="895" y="117" width="70" height="20" rx="10" fill="#fecaca" stroke="#ef4444" strokeWidth="1.5" />
              <text x="930" y="131" textAnchor="middle" fontSize="11" fontWeight="700" fill="#7f1d1d">Hard</text>
            </g>
            <text x="890" y="32" textAnchor="middle" fontSize="14" fontWeight="700" fill="#312e81">Promoted</text>
          </g>

          {/* === DISCARDED (trash can) === */}
          <g>
            <rect x="800" y="300" width="180" height="80" rx="14" ry="14" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="2" strokeDasharray="4 3" />
            <g transform="translate(890 340)">
              <rect x="-18" y="-19" width="36" height="4" rx="1" fill="#64748b" />
              <rect x="-7" y="-23" width="14" height="4" rx="1" fill="#64748b" />
              <path d="M -16,-13 L 16,-13 L 13,18 L -13,18 Z" fill="#cbd5e1" stroke="#64748b" strokeWidth="1.5" />
              <line x1="-6" y1="-9" x2="-8" y2="14" stroke="#64748b" strokeWidth="1.5" />
              <line x1="0" y1="-9" x2="0" y2="14" stroke="#64748b" strokeWidth="1.5" />
              <line x1="6" y1="-9" x2="8" y2="14" stroke="#64748b" strokeWidth="1.5" />
            </g>
            <text x="890" y="370" textAnchor="middle" fontSize="13" fontWeight="700" fill="#475569">Discarded</text>
          </g>

          {/* === FORWARD ARROWS === */}
          <line x1="160" y1="230" x2="200" y2="230" stroke="#475569" strokeWidth="2" markerEnd="url(#ps-ah-solid)" />
          <text x="180" y="222" textAnchor="middle" fontSize="10" fill="#475569">data</text>

          <line x1="340" y1="230" x2="380" y2="230" stroke="#475569" strokeWidth="2" markerEnd="url(#ps-ah-solid)" />
          <text x="360" y="222" textAnchor="middle" fontSize="10" fill="#475569">MCQs</text>

          <line x1="520" y1="230" x2="560" y2="230" stroke="#475569" strokeWidth="2" markerEnd="url(#ps-ah-solid)" />
          <text x="540" y="222" textAnchor="middle" fontSize="10" fill="#475569">answers</text>

          {/* === ARBITER FORK: KEEP up, DROP down === */}
          <path d="M 700 200 C 750 200 750 100 800 100" fill="none" stroke="#16a34a" strokeWidth="2.5" markerEnd="url(#ps-ah-keep)" />
          <text x="755" y="152" textAnchor="middle" fontSize="10" fontWeight="700" fill="#16a34a">KEEP: wrong</text>
          <text x="755" y="166" textAnchor="middle" fontSize="10" fontWeight="600" fill="#16a34a">or right + low conf.</text>

          <path d="M 700 260 C 750 260 750 340 800 340" fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="3 3" markerEnd="url(#ps-ah-drop)" />
          <text x="755" y="302" textAnchor="middle" fontSize="10" fontWeight="600" fill="#64748b">DROP: right</text>
          <text x="755" y="316" textAnchor="middle" fontSize="10" fontWeight="600" fill="#64748b">+ medium/high conf.</text>

          {/* === FEEDBACK LOOP with lightbulb === */}
          <path d="M 630 290 L 630 430 L 270 430 L 270 290" fill="none" stroke="#2f6bff" strokeWidth="2" strokeDasharray="6 4" markerEnd="url(#ps-ah-feedback)" />
          <g transform="translate(450 425)">
            <line x1="0" y1="-20" x2="0" y2="-15" stroke="#ca8a04" strokeWidth="1.5" />
            <line x1="-14" y1="-13" x2="-10" y2="-9" stroke="#ca8a04" strokeWidth="1.5" />
            <line x1="14" y1="-13" x2="10" y2="-9" stroke="#ca8a04" strokeWidth="1.5" />
            <circle cx="0" cy="-2" r="11" fill="#fef9c3" stroke="#ca8a04" strokeWidth="2" />
            <line x1="-5" y1="-2" x2="5" y2="-2" stroke="#ca8a04" strokeWidth="1.5" />
            <line x1="-3" y1="3" x2="3" y2="3" stroke="#ca8a04" strokeWidth="1.5" />
            <rect x="-4" y="9" width="8" height="3" fill="#ca8a04" />
          </g>
          <text x="498" y="429" fontSize="10" fontWeight="700" fill="#2f6bff">trap hints → next Generator prompt</text>
        </svg>

        <div className="ps-mcq-figure-explain">
          <div className="ps-mcq-figure-explain-block">
            <h4 className="ps-mcq-figure-explain-title">Easy / Medium / Hard</h4>
            <p className="ps-mcq-figure-explain-lead">
              The Arbiter does <em>not</em> pick the tier. Difficulty is set when the question is{" "}
              <strong>authored</strong>:
            </p>
            <ul className="ps-mcq-figure-explain-list">
              <li>
                <strong>Templates</strong> (this app’s <strong>Generate MCQs</strong>): each generator function is
                labeled Easy, Medium, or Hard in code—lookup vs. one formula vs. multi-step.
              </li>
              <li>
                <strong>LLM Generator</strong>: the model marks each JSON question{" "}
                <code className="ps-mcq-code">Easy</code>, <code className="ps-mcq-code">Medium</code>, or{" "}
                <code className="ps-mcq-code">Hard</code> using the same idea: single-step read, one derived quantity,
                or chained reasoning / traps.
              </li>
            </ul>
            <p className="ps-mcq-figure-explain-note">Promoted sets still show Easy/Medium/Hard buckets—that is the question’s label, not a second sort by the judge.</p>
          </div>
          <div className="ps-mcq-figure-explain-block">
            <h4 className="ps-mcq-figure-explain-title">How the Arbiter judges</h4>
            <p className="ps-mcq-figure-explain-lead">
              Deterministic code. It compares the Solver’s choice (A–D) to{" "}
              <code className="ps-mcq-code">correct_answer</code> and reads self-reported{" "}
              <code className="ps-mcq-code">confidence</code> (low / medium / high):
            </p>
            <ul className="ps-mcq-figure-explain-list">
              <li>
                <strong>KEEP → Promoted</strong> if the answer is <strong>wrong</strong>, or{" "}
                <strong>right with low confidence</strong>, or there is <strong>no Solver reply</strong> for that
                question (treated as worth human review).
              </li>
              <li>
                <strong>DROP → Discarded</strong> if the answer is <strong>correct</strong>{" "}
                <em>and</em> confidence is <strong>medium</strong> or <strong>high</strong>.
              </li>
            </ul>
          </div>
          <div className="ps-mcq-figure-explain-block ps-mcq-figure-explain-block--full">
            <h4 className="ps-mcq-figure-explain-title">How feedback works</h4>
            <p className="ps-mcq-figure-explain-lead">
              There is <strong>no gradient or weight update</strong>. Feedback is a <strong>short paragraph of plain
              English</strong> that gets pasted into the <strong>next</strong> Generator API call as extra instructions
              (see <code className="ps-mcq-code">build_feedback</code> → <code className="ps-mcq-code">extra_guidance</code>{" "}
              in <code className="ps-mcq-code">opf_mcq_adversarial.py</code>).
            </p>
            <ol className="ps-mcq-figure-explain-steps">
              <li>
                <strong>After each round</strong>, the Arbiter has already marked every MCQ as KEEP (Promoted) or DROP
                (Discarded).
              </li>
              <li>
                The pipeline looks only at questions where the Solver was <strong>wrong</strong> (wrong letter vs{" "}
                <code className="ps-mcq-code">correct_answer</code>). Those are the “fooled” examples.
                <span className="ps-mcq-figure-explain-note ps-mcq-figure-explain-note--inline">
                  {" "}
                  Questions <strong>kept</strong> because the Solver was <strong>right but unsure</strong> (low
                  confidence) still count as Promoted for your dataset, but they <strong>do not</strong> add lines to this
                  feedback text—only incorrect Solver picks do.
                </span>
              </li>
              <li>
                It copies up to <strong>five</strong> of their <code className="ps-mcq-code">trap_description</code>{" "}
                strings (what misconception the bad option exploits), plus a line of the question stem for context, into one
                block of text.
              </li>
              <li>
                On the <strong>next</strong> round, that block is appended to the Generator prompt so the model is told:
                “these kinds of traps just worked—now write <strong>new</strong> questions that use the <em>same</em> idea
                on <em>different</em> buses, lines, or generators.”
              </li>
              <li>
                If the Solver answered <strong>every</strong> question correctly this round, there are no fooled examples.
                Instead, a <strong>fixed</strong> message tells the Generator to tighten distractors (e.g. within ~5% of
                the true value, multi-step stems).
              </li>
              <li>
                Feedback is computed from the <strong>immediately previous round only</strong>, not from the full history of
                all earlier rounds in one blob.
              </li>
              <li>
                If the Generator left <code className="ps-mcq-code">trap_description</code> blank on fooled questions,
                the hint list can be <strong>empty</strong> and the next round may get <strong>no</strong> trap-specific
                feedback until the model fills that field.
              </li>
            </ol>
            <p className="ps-mcq-figure-explain-example-label">Example of what the Generator literally sees added to its prompt:</p>
            <pre className="ps-mcq-feedback-example" tabIndex={0}>
{`FEEDBACK FROM PREVIOUS ROUND - these trap types successfully fooled the Solver:
  - 'Uses Sig = |P|+|Q| instead of sqrt(P²+Q²)'  (fooled Solver on: For Line 1-2, what is the apparent power at the from end?)
  - 'Takes Ploss as Pf − Pt instead of Pf + Pt'  (fooled Solver on: …)
Craft new questions that exploit similar misconceptions but on different
elements (different lines / generators / buses).`}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}

function ModelSelectionPage({
  fixedPrompt,
  onFixedPromptChange,
  onRefreshPromptFromCircuit,
  promptBuildStatus,
  promptBuildError,
  openAiApiKey,
  onOpenAiApiKeyChange,
  claudeApiKey,
  onClaudeApiKeyChange,
  cursorApiKey,
  onCursorApiKeyChange,
  rememberApiKeys,
  onRememberApiKeysChange,
  onEvaluateModel,
  evaluationStatus,
  evaluationError,
  evaluationResult,
  circuitModel,
}) {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_EVAL_MODEL);
  const [mode, setMode] = useState("no_tool_use");
  const [showOpenAiApiKey, setShowOpenAiApiKey] = useState(false);
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [showCursorApiKey, setShowCursorApiKey] = useState(false);
  const selectedProvider = providerFromModel(selectedModel);
  const hasSelectedProviderKey =
    selectedProvider === "claude"
      ? Boolean(claudeApiKey.trim())
      : selectedProvider === "cursor"
        ? Boolean(cursorApiKey.trim())
        : Boolean(openAiApiKey.trim());
  const difficultyStats = evaluationResult?.accuracy_by_difficulty || {};
  const evaluationDetails = evaluationResult?.details || [];

  const handleRunModel = () => {
    onEvaluateModel({
      model: selectedModel,
      mode,
      prompt: fixedPrompt,
      openAiApiKey,
      claudeApiKey,
      cursorApiKey,
      circuitModel,
    });
  };

  return (
    <div className="ps-page-content">
      <h2 className="ps-page-title">Model Evaluation</h2>
      <section className="ps-panel ps-design-panel">
        <div className="ps-model-grid">
          <div className="ps-model-prompt-panel">
            <div className="ps-panel-head-bar ps-panel-head-bar-tight">
              <h3 className="ps-subsection-heading">Fixed prompt (editable)</h3>
              <button
                type="button"
                className="ps-btn-accent ps-btn-reload"
                onClick={onRefreshPromptFromCircuit}
                disabled={promptBuildStatus === "loading"}
              >
                {promptBuildStatus === "loading" ? "Updating Prompt..." : "Use Current Circuit Prompt"}
              </button>
            </div>
            <p className="ps-json-hint">
              This prompt stays fixed for evaluation runs, but you can edit it any time before running a model.
            </p>
            {promptBuildError ? <p className="ps-error-inline">{promptBuildError}</p> : null}
            <textarea
              className="ps-json ps-model-prompt-input"
              spellCheck={false}
              value={fixedPrompt}
              onChange={(e) => onFixedPromptChange(e.target.value)}
            />
          </div>

          <div className="ps-model-run-panel">
            <h3 className="ps-subsection-heading">Model and API setup</h3>
            <div className="ps-model-field-stack">
              <label className="ps-mcq-input-group">
                <span>API keys</span>
                <div className="ps-model-key-grid">
                  <div className="ps-model-key-row">
                    <input
                      className="ps-input"
                      type={showOpenAiApiKey ? "text" : "password"}
                      value={openAiApiKey}
                      onChange={(e) => onOpenAiApiKeyChange(e.target.value)}
                      placeholder="OpenAI key (sk-...)"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="ps-btn-accent ps-btn-reload ps-model-key-toggle"
                      onClick={() => setShowOpenAiApiKey((s) => !s)}
                    >
                      {showOpenAiApiKey ? "Hide" : "Show"}
                    </button>
                  </div>
                  <div className="ps-model-key-row">
                    <input
                      className="ps-input"
                      type={showClaudeApiKey ? "text" : "password"}
                      value={claudeApiKey}
                      onChange={(e) => onClaudeApiKeyChange(e.target.value)}
                      placeholder="Claude key (sk-ant-...)"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="ps-btn-accent ps-btn-reload ps-model-key-toggle"
                      onClick={() => setShowClaudeApiKey((s) => !s)}
                    >
                      {showClaudeApiKey ? "Hide" : "Show"}
                    </button>
                  </div>
                  <div className="ps-model-key-row">
                    <input
                      className="ps-input"
                      type={showCursorApiKey ? "text" : "password"}
                      value={cursorApiKey}
                      onChange={(e) => onCursorApiKeyChange(e.target.value)}
                      placeholder="Cursor key (key_...)"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="ps-btn-accent ps-btn-reload ps-model-key-toggle"
                      onClick={() => setShowCursorApiKey((s) => !s)}
                    >
                      {showCursorApiKey ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
                <span className="ps-model-mini-hint">
                  OpenAI models use the OpenAI key. Claude models use the Claude key.
                  Cursor models (cursor:*) use the Cursor key and require the
                  cursor-agent CLI installed locally.
                </span>
              </label>

              <label className="ps-mcq-input-group">
                <span>Model (dropdown)</span>
                <select
                  className="ps-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  aria-label="Select model"
                >
                  {MODEL_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="ps-mcq-input-group">
                <span>Mode</span>
                <select className="ps-select" value={mode} onChange={(e) => setMode(e.target.value)}>
                  {EVAL_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ps-model-remember">
                <input
                  type="checkbox"
                  checked={rememberApiKeys}
                  onChange={(e) => onRememberApiKeysChange(e.target.checked)}
                />
                Remember API key for this browser session
              </label>
            </div>

            <button
              type="button"
              className="ps-btn-accent ps-btn-run"
              onClick={handleRunModel}
              disabled={evaluationStatus === "loading" || !fixedPrompt.trim() || !hasSelectedProviderKey}
            >
              {evaluationStatus === "loading" ? "Running Evaluation..." : "Run Questions For Selected Model"}
            </button>

            {evaluationError ? <p className="ps-error-inline">{evaluationError}</p> : null}

            {evaluationResult ? (
              <div className="ps-model-result-card ps-model-result-expanded">
                <div className="ps-model-summary-grid">
                  <p>
                    <strong>Model:</strong> {evaluationResult.model}
                  </p>
                  <p>
                    <strong>Mode:</strong> {evaluationResult.mode || mode}
                  </p>
                  <p>
                    <strong>Accuracy:</strong> {evaluationResult.accuracy_pct}% ({evaluationResult.correct}/
                    {evaluationResult.total_questions})
                  </p>
                  <p>
                    <strong>Wrong Questions:</strong> {evaluationResult.wrong_question_ids?.length || 0}
                  </p>
                </div>

                <div className="ps-model-difficulty-grid">
                  {["easy", "medium", "hard", "manual"].map((level) => {
                    const stat = difficultyStats[level] || { total: 0, correct: 0, accuracy_pct: 0 };
                    return (
                      <div key={level} className="ps-model-difficulty-card">
                        <span className="ps-model-difficulty-label">{level.toUpperCase()}</span>
                        <strong>{stat.accuracy_pct}%</strong>
                        <span>
                          {stat.correct}/{stat.total}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="ps-eval-scroll-wrap">
                  {evaluationDetails.map((d) => {
                    const trace = d.evaluation_trace || {};
                    const toolCalls = trace.tool_calls || [];
                    return (
                      <article key={d.question_id} className="ps-eval-item">
                        <div className="ps-eval-item-head">
                          <strong>Q{d.question_id}</strong>
                          <span className={d.correct ? "ps-eval-badge ps-eval-ok" : "ps-eval-badge ps-eval-wrong"}>
                            {d.correct ? "Correct" : "Wrong"}
                          </span>
                        </div>
                        <p className="ps-eval-question">{d.question}</p>
                        <div className="ps-eval-meta-row">
                          <span>Difficulty: {d.difficulty || "-"}</span>
                          <span>Expected: {d.expected}</span>
                          <span>Model: {d.model_answer}</span>
                        </div>
                        <div className="ps-eval-meta-row">
                          <span>Tools used: {trace.used_tools ? "Yes" : "No"}</span>
                          <span>Tool calls: {trace.tool_call_count || 0}</span>
                          <span>Simulation: {trace.simulation_executed ? "Yes" : "No"}</span>
                          <span>Code/file written: {trace.wrote_files ? "Yes" : "No"}</span>
                        </div>
                        {toolCalls.length > 0 ? (
                          <details className="ps-eval-tool-details">
                            <summary>Tool trace</summary>
                            <ul className="ps-eval-tool-list">
                              {toolCalls.map((tc, idx) => (
                                <li key={`${d.question_id}-${idx}`}>
                                  <strong>{tc.name}</strong> - {tc.success ? "success" : "failed"}
                                  {tc.return_code != null ? ` (return_code=${tc.return_code})` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        <details className="ps-eval-tool-details">
                          <summary>Model raw output / error</summary>
                          <pre className="ps-eval-raw">{d.model_raw || "-"}</pre>
                        </details>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="ps-placeholder-text">
                Pick a model from the dropdown, provide API key, then run to view model-wise accuracy.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function CircuitPage({
  onRunOpf,
  onSystemChange,
  opfStatus,
  opfError,
  opfRun,
  mcqError,
  hasMcqs,
}) {
  const [system, setSystem] = useState(() => structuredClone(DEFAULT_SYSTEM));
  const [jsonText, setJsonText] = useState(() => systemToPrettyJson(DEFAULT_SYSTEM));
  const [jsonError, setJsonError] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [highlightLineIndex, setHighlightLineIndex] = useState(null);

  useEffect(() => {
    onSystemChange(system);
  }, [onSystemChange, system]);

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
  const isRunningOpf = opfStatus === "loading";
  const opfResults = opfRun?.results || null;
  const opfSummary = opfRun?.results?.summary || null;

  const handleRunOpf = useCallback(() => {
    onRunOpf(system);
  }, [onRunOpf, system]);

  return (
    <div className="ps-page-content">
      <div className="ps-circuit-grid">
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
                <span className="ps-toolbar-inline-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="ps-btn-accent ps-btn-run"
                  onClick={handleRunOpf}
                  disabled={isRunningOpf}
                >
                  {isRunningOpf ? "Running OPF..." : "Run OPF"}
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

            <div className="ps-json-section">
              <h3 className="ps-subsection-heading">OPF run result</h3>
              {opfError ? <div className="ps-json-error">{opfError}</div> : null}
              {mcqError ? <div className="ps-json-error">{mcqError}</div> : null}
              {opfSummary ? (
                <>
                  <div className="ps-opf-status-row">
                    <span className={`ps-opf-pill ${opfResults?.converged ? "ps-opf-pill-ok" : "ps-opf-pill-warn"}`}>
                      {opfResults?.converged ? "Converged" : "Not converged"}
                    </span>
                    <span className="ps-opf-pill">Iterations: {opfResults?.iterations}</span>
                    <span className="ps-opf-pill">Error: {opfResults?.error}</span>
                  </div>

                  <div className="ps-opf-summary-grid">
                    <div className="ps-opf-card">
                      <span className="ps-opf-label">Total Generation P</span>
                      <strong>{opfSummary.total_gen_P_MW} MW</strong>
                    </div>
                    <div className="ps-opf-card">
                      <span className="ps-opf-label">Total Load P</span>
                      <strong>{opfSummary.total_load_P_MW} MW</strong>
                    </div>
                    <div className="ps-opf-card">
                      <span className="ps-opf-label">Total Loss P</span>
                      <strong>{opfSummary.total_Ploss_MW} MW</strong>
                    </div>
                    <div className="ps-opf-card">
                      <span className="ps-opf-label">Total Cost</span>
                      <strong>{opfSummary.total_cost}</strong>
                    </div>
                  </div>

                  <details className="ps-opf-block" open>
                    <summary>Bus results ({opfResults?.buses?.length || 0})</summary>
                    <div className="ps-opf-table-wrap">
                      <table className="ps-opf-table">
                        <thead>
                          <tr>
                            <th>Bus</th>
                            <th>Name</th>
                            <th>Vm (p.u.)</th>
                            <th>Va (deg)</th>
                            <th>P (MW)</th>
                            <th>Q (Mvar)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(opfResults?.buses || []).map((bus) => (
                            <tr key={`bus-${bus.index}`}>
                              <td>{bus.index}</td>
                              <td>{bus.name}</td>
                              <td>{bus.Vm}</td>
                              <td>{bus.Va_deg}</td>
                              <td>{bus.P_MW}</td>
                              <td>{bus.Q_Mvar}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="ps-opf-block">
                    <summary>Generator dispatch ({opfResults?.generators?.length || 0})</summary>
                    <div className="ps-opf-table-wrap">
                      <table className="ps-opf-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Name</th>
                            <th>Bus</th>
                            <th>P (MW)</th>
                            <th>Q (Mvar)</th>
                            <th>Pmin</th>
                            <th>Pmax</th>
                            <th>Pcost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(opfResults?.generators || []).map((gen) => (
                            <tr key={`gen-${gen.index}`}>
                              <td>{gen.index}</td>
                              <td>{gen.name}</td>
                              <td>{gen.bus}</td>
                              <td>{gen.P_MW}</td>
                              <td>{gen.Q_Mvar ?? "-"}</td>
                              <td>{gen.Pmin}</td>
                              <td>{gen.Pmax}</td>
                              <td>{gen.Pcost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="ps-opf-block">
                    <summary>Branch results ({opfResults?.branches?.length || 0})</summary>
                    <div className="ps-opf-table-wrap">
                      <table className="ps-opf-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Name</th>
                            <th>From</th>
                            <th>To</th>
                            <th>Pf</th>
                            <th>Pt</th>
                            <th>Loading %</th>
                            <th>Ploss</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(opfResults?.branches || []).map((br) => (
                            <tr key={`br-${br.index}`}>
                              <td>{br.index}</td>
                              <td>{br.name}</td>
                              <td>{br.from_bus}</td>
                              <td>{br.to_bus}</td>
                              <td>{br.Pf_MW}</td>
                              <td>{br.Pt_MW}</td>
                              <td>{br.loading_pct}</td>
                              <td>{br.Ploss_MW}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>

                  <details className="ps-opf-block">
                    <summary>Load results ({opfResults?.loads?.length || 0})</summary>
                    <div className="ps-opf-table-wrap">
                      <table className="ps-opf-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Name</th>
                            <th>Bus</th>
                            <th>P (MW)</th>
                            <th>Q (Mvar)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(opfResults?.loads || []).map((load) => (
                            <tr key={`load-${load.index}`}>
                              <td>{load.index}</td>
                              <td>{load.name}</td>
                              <td>{load.bus}</td>
                              <td>{load.P_MW}</td>
                              <td>{load.Q_Mvar}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              ) : (
                <p className="ps-placeholder-text">
                  Run OPF to see results here. Then generate MCQs to populate the MCQ Questions page.
                </p>
              )}
              {opfRun?.stdout ? (
                <details className="ps-opf-log">
                  <summary>Console output from `web_opf_agent.py`</summary>
                  <pre>{opfRun.stdout}</pre>
                </details>
              ) : null}
              {hasMcqs ? <p className="ps-mcq-note">MCQs are ready in the MCQ Questions panel.</p> : null}
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
                          <input className="ps-input ps-input-narrow" type="number" value={g.bus}
                            onChange={(e) => updateGen(i, { bus: num(e.target.value, g.bus) })} />
                        </td>
                        <td>
                          <input className="ps-input" value={g.name}
                            onChange={(e) => updateGen(i, { name: e.target.value })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" value={g.Pmin}
                            onChange={(e) => updateGen(i, { Pmin: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" value={g.Pmax}
                            onChange={(e) => updateGen(i, { Pmax: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.001" value={g.a}
                            onChange={(e) => updateGen(i, { a: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.1" value={g.b}
                            onChange={(e) => updateGen(i, { b: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.01" value={g.vset}
                            onChange={(e) => updateGen(i, { vset: num(e.target.value) })} />
                        </td>
                        <td>
                          <button type="button" className="ps-icon-btn" onClick={() => removeGen(i)}>×</button>
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
                          <input className="ps-input ps-input-narrow" type="number" value={l.bus}
                            onChange={(e) => updateLoad(i, { bus: num(e.target.value, l.bus) })} />
                        </td>
                        <td>
                          <input className="ps-input" value={l.name}
                            onChange={(e) => updateLoad(i, { name: e.target.value })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" value={l.P}
                            onChange={(e) => updateLoad(i, { P: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" value={l.Q}
                            onChange={(e) => updateLoad(i, { Q: num(e.target.value) })} />
                        </td>
                        <td>
                          <button type="button" className="ps-icon-btn" onClick={() => removeLoad(i)}>×</button>
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
                          <select className="ps-select" value={ln.from}
                            onChange={(e) => updateLine(i, { from: num(e.target.value) })}>
                            {busList.map((b) => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </td>
                        <td>
                          <select className="ps-select" value={ln.to}
                            onChange={(e) => updateLine(i, { to: num(e.target.value) })}>
                            {busList.map((b) => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </td>
                        <td>
                          <input className="ps-input" value={ln.name}
                            onChange={(e) => updateLine(i, { name: e.target.value })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.001" value={ln.r}
                            onChange={(e) => updateLine(i, { r: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.001" value={ln.x}
                            onChange={(e) => updateLine(i, { x: num(e.target.value) })} />
                        </td>
                        <td>
                          <input className="ps-input ps-input-narrow" type="number" step="0.001" value={ln.b}
                            onChange={(e) => updateLine(i, { b: num(e.target.value) })} />
                        </td>
                        <td>
                          <button type="button" className="ps-icon-btn" onClick={() => removeLine(i)}>×</button>
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
    </div>
  );
}

function AppInner() {
  const [opfStatus, setOpfStatus] = useState("idle");
  const [opfError, setOpfError] = useState("");
  const [opfRun, setOpfRun] = useState(null);
  const [currentCircuitModel, setCurrentCircuitModel] = useState(() => structuredClone(DEFAULT_SYSTEM));

  const [mcqStatus, setMcqStatus] = useState("idle");
  const [mcqError, setMcqError] = useState("");
  const [mcqDiagnostics, setMcqDiagnostics] = useState(null);
  const [mcqData, setMcqData] = useState(null);
  const [fixedPrompt, setFixedPrompt] = useState(() => {
    const saved = window.localStorage.getItem("ps_fixed_eval_prompt");
    return saved || DEFAULT_MODEL_PROMPT;
  });
  const [evaluationStatus, setEvaluationStatus] = useState("idle");
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [promptBuildStatus, setPromptBuildStatus] = useState("idle");
  const [promptBuildError, setPromptBuildError] = useState("");
  const [rememberApiKeys, setRememberApiKeys] = useState(() => window.sessionStorage.getItem("ps_remember_keys") === "1");
  const [openAiApiKey, setOpenAiApiKey] = useState(() => window.sessionStorage.getItem("ps_openai_key") || "");
  const [claudeApiKey, setClaudeApiKey] = useState(() => window.sessionStorage.getItem("ps_claude_key") || "");
  const [cursorApiKey, setCursorApiKey] = useState(() => window.sessionStorage.getItem("ps_cursor_key") || "");

  useEffect(() => {
    window.localStorage.setItem("ps_fixed_eval_prompt", fixedPrompt);
  }, [fixedPrompt]);

  useEffect(() => {
    if (rememberApiKeys) {
      window.sessionStorage.setItem("ps_remember_keys", "1");
      window.sessionStorage.setItem("ps_openai_key", openAiApiKey);
      window.sessionStorage.setItem("ps_claude_key", claudeApiKey);
      window.sessionStorage.setItem("ps_cursor_key", cursorApiKey);
      return;
    }
    window.sessionStorage.removeItem("ps_remember_keys");
    window.sessionStorage.removeItem("ps_openai_key");
    window.sessionStorage.removeItem("ps_claude_key");
    window.sessionStorage.removeItem("ps_cursor_key");
  }, [rememberApiKeys, openAiApiKey, claudeApiKey, cursorApiKey]);

  const runOpfFromUi = useCallback(async (model) => {
    setOpfStatus("loading");
    setOpfError("");
    try {
      const response = await fetch(resolveAppPath("/api/run-opf"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to run OPF.");
      }
      setOpfRun({
        stdout: payload.stdout || "",
        stderr: payload.stderr || "",
        results: payload.results || null,
      });
      setOpfStatus("success");
    } catch (error) {
      setOpfStatus("error");
      setOpfError(error?.message || String(error));
    }
  }, []);

  const generateMcqsFromUi = useCallback(
    async ({
      opfResults,
      easy = 50,
      medium = 50,
      hard = 50,
      seed = 42,
      mode = "templates",
      genModel = "claude-sonnet-4-5",
      solverModel = "claude-sonnet-4-5",
      rounds = 2,
    } = {}) => {
      const usableResults = opfResults || opfRun?.results;
      if (!usableResults) {
        setMcqStatus("error");
        setMcqError("Run OPF first so MCQs can be generated from its results.");
        return;
      }

      setMcqStatus("loading");
      setMcqError("");
      setMcqDiagnostics(null);
      try {
        const response = await fetch(resolveAppPath("/api/generate-mcq"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            opfResults: usableResults,
            seed,
            easy,
            medium,
            hard,
            mode,
            genModel,
            solverModel,
            rounds,
            claudeApiKey,
            openAiApiKey,
          }),
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok || !payload || !payload.ok) {
          const message =
            payload?.error ||
            (response.ok
              ? "MCQ generation finished but returned no questions."
              : `Server returned HTTP ${response.status}.`);
          setMcqStatus("error");
          setMcqError(message);
          setMcqDiagnostics({
            stderr: payload?.stderr || "",
            stdout: payload?.stdout || "",
            mode,
            genModel,
            solverModel,
          });
          if (payload?.mcq) setMcqData(payload.mcq);
          return;
        }
        setMcqData(payload.mcq || null);
        setMcqStatus("success");
        if (payload.stderr) {
          setMcqDiagnostics({
            stderr: payload.stderr,
            stdout: payload.stdout || "",
            mode,
            genModel,
            solverModel,
          });
        }
      } catch (error) {
        setMcqStatus("error");
        setMcqError(error?.message || String(error));
      }
    },
    [opfRun, claudeApiKey, openAiApiKey]
  );

  const addManualMcq = useCallback((manual) => {
    if (!manual) return;
    setMcqData((prev) => {
      const prevQuestions = prev?.questions || [];
      const nextId = prevQuestions.length
        ? Math.max(...prevQuestions.map((q) => Number(q.id) || 0)) + 1
        : 1;
      const nextQuestion = {
        id: nextId,
        question: manual.question,
        options: manual.options,
        correct_answer: manual.correct_answer,
        correct_value: manual.correct_value,
        category: "Manual",
        difficulty: "manually added",
        explanation: manual.explanation || "Manually added question.",
        source: "manual",
        template_name: "manual_add",
      };
      const allQuestions = [...prevQuestions, nextQuestion];
      const easyCount = allQuestions.filter((q) => q.difficulty === "Easy").length;
      const mediumCount = allQuestions.filter((q) => q.difficulty === "Medium").length;
      const hardCount = allQuestions.filter((q) => q.difficulty === "Hard").length;
      const categories = [...new Set(allQuestions.map((q) => q.category).filter(Boolean))];

      return {
        metadata: {
          ...(prev?.metadata || {}),
          easy_count: easyCount,
          medium_count: mediumCount,
          hard_count: hardCount,
          total_questions: allQuestions.length,
          categories,
        },
        opf_summary: prev?.opf_summary || null,
        questions: allQuestions,
      };
    });
    setMcqStatus("success");
    setMcqError("");
  }, []);

  const evaluateModelFromUi = useCallback(async ({ model, mode, prompt, openAiApiKey, claudeApiKey, cursorApiKey, circuitModel }) => {
    setEvaluationStatus("loading");
    setEvaluationError("");
    try {
      const response = await fetch(resolveAppPath("/api/evaluate-model"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, mode, prompt, openAiApiKey, claudeApiKey, cursorApiKey, circuitModel }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to run model evaluation.");
      }
      setEvaluationResult(payload.evaluation || null);
      setEvaluationStatus("success");
    } catch (error) {
      setEvaluationStatus("error");
      setEvaluationError(error?.message || String(error));
    }
  }, []);

  const buildPromptFromCircuitFromUi = useCallback(async () => {
    setPromptBuildStatus("loading");
    setPromptBuildError("");
    try {
      const response = await fetch(resolveAppPath("/api/build-prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: currentCircuitModel,
          answerFormat: "letter_only",
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Failed to build prompt from current circuit.");
      }
      if (!String(payload.prompt || "").trim()) {
        throw new Error("Prompt builder returned an empty prompt.");
      }
      setFixedPrompt(payload.prompt);
      setPromptBuildStatus("success");
    } catch (error) {
      setPromptBuildStatus("error");
      setPromptBuildError(error?.message || String(error));
    }
  }, [currentCircuitModel]);

  return (
    <div className="ps-app-shell">
      <aside className="ps-sidebar" aria-label="Main navigation">
        <div className="ps-sidebar-brand">
          <span className="ps-sidebar-logo">Agentic Veragrid</span>
        </div>
        <nav className="ps-sidebar-nav">
          <NavLink to="/circuit" className={({ isActive }) => `ps-sidebar-link${isActive ? " ps-sidebar-link-active" : ""}`}>
            <span className="ps-sidebar-icon">&#9881;</span>
            Designing Circuit Diagram
          </NavLink>
          <NavLink to="/mcq" className={({ isActive }) => `ps-sidebar-link${isActive ? " ps-sidebar-link-active" : ""}`}>
            <span className="ps-sidebar-icon">&#9998;</span>
            MCQ Questions
          </NavLink>
          <NavLink to="/model" className={({ isActive }) => `ps-sidebar-link${isActive ? " ps-sidebar-link-active" : ""}`}>
            <span className="ps-sidebar-icon">&#9670;</span>
            Model Evaluation
          </NavLink>
        </nav>
      </aside>

      <div className="ps-main-area">
        <header className="topbar ps-site-header">
          <div className="topbarInner ps-site-header-inner">
            <h1 className="ps-site-title">Agentic Veragrid Evaluation</h1>
          </div>
        </header>

        <main className="ps-main-content">
          <Routes>
            <Route
              path="/circuit"
              element={
                <CircuitPage
                  onRunOpf={runOpfFromUi}
                  onSystemChange={setCurrentCircuitModel}
                  opfStatus={opfStatus}
                  opfError={opfError}
                  opfRun={opfRun}
                  mcqError={mcqError}
                  hasMcqs={Boolean(mcqData?.questions?.length)}
                />
              }
            />
            <Route
              path="/mcq"
              element={
                <MCQPage
                  mcqData={mcqData}
                  mcqStatus={mcqStatus}
                  mcqError={mcqError}
                  mcqDiagnostics={mcqDiagnostics}
                  onGenerateMcqs={generateMcqsFromUi}
                  onAddManualMcq={addManualMcq}
                  hasOpfResults={Boolean(opfRun?.results)}
                  claudeApiKey={claudeApiKey}
                  onClaudeApiKeyChange={setClaudeApiKey}
                  openAiApiKey={openAiApiKey}
                  onOpenAiApiKeyChange={setOpenAiApiKey}
                />
              }
            />
            <Route
              path="/model"
              element={
                <ModelSelectionPage
                  fixedPrompt={fixedPrompt}
                  onFixedPromptChange={setFixedPrompt}
                  onRefreshPromptFromCircuit={buildPromptFromCircuitFromUi}
                  promptBuildStatus={promptBuildStatus}
                  promptBuildError={promptBuildError}
                  openAiApiKey={openAiApiKey}
                  onOpenAiApiKeyChange={setOpenAiApiKey}
                  claudeApiKey={claudeApiKey}
                  onClaudeApiKeyChange={setClaudeApiKey}
                  cursorApiKey={cursorApiKey}
                  onCursorApiKeyChange={setCursorApiKey}
                  rememberApiKeys={rememberApiKeys}
                  onRememberApiKeysChange={setRememberApiKeys}
                  onEvaluateModel={evaluateModelFromUi}
                  evaluationStatus={evaluationStatus}
                  evaluationError={evaluationError}
                  evaluationResult={evaluationResult}
                  circuitModel={currentCircuitModel}
                />
              }
            />
            <Route path="*" element={<Navigate to="/circuit" replace />} />
          </Routes>
        </main>
      </div>
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
