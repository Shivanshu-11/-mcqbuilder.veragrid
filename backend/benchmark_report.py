#!/usr/bin/env python3
"""
VeraGrid MCQ Benchmark — analysis + paper-style PDF report.

Reads the per-question JSONL files produced by benchmark_runner.py from
benchmark_results/raw/, aggregates them into paper-style tables (accuracy by
difficulty tier, interface-complexity ladder deltas, failure decomposition),
renders matplotlib figures, and builds a PDF report with reportlab.

Run with the .venv312 interpreter (has matplotlib + reportlab):
  /Users/shivanshutripathi/PSCAD/.venv312/bin/python benchmark_report.py
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(BACKEND_DIR, "benchmark_results", "raw")
OUT_DIR = os.path.join(BACKEND_DIR, "benchmark_results")
FIG_DIR = os.path.join(OUT_DIR, "figures")
PDF_PATH = os.path.join(OUT_DIR, "veragrid_llm_benchmark_report.pdf")
QUESTIONS_FILE = os.path.join(BACKEND_DIR, "mcq_questions.web.json")
CIRCUIT_FILE = os.path.join(BACKEND_DIR, "eval_circuit.web.json")

MODELS = ["gpt-5.2", "claude-4.5-sonnet", "gemini-3-flash", "grok-4.3", "grok-4.5-xhigh", "composer-2.5", "claude-opus-4-8"]
MODEL_NAMES = {
    "gpt-5.2": "GPT-5.2",
    "claude-4.5-sonnet": "Claude Sonnet 4.5",
    "gemini-3-flash": "Gemini 3 Flash",
    "grok-4.3": "Grok 4.3",
    "grok-4.5-xhigh": "Grok 4.5",
    "composer-2.5": "Composer 2.5",
    "claude-opus-4-8": "Opus 4.8",
}
MODES = ["no_tool", "code_generation", "agent"]
MODE_NAMES = {"no_tool": "No tool", "code_generation": "Code gen", "agent": "Agent"}
DIFFS = ["Easy", "Medium", "Hard"]


def slug(s: str) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9.]+", "-", s).strip("-")


def load_records() -> dict[tuple[str, str], list[dict[str, Any]]]:
    data: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for model in MODELS:
        for mode in MODES:
            path = os.path.join(RAW_DIR, f"{slug(model)}__{mode}.jsonl")
            if not os.path.exists(path):
                continue
            recs = []
            seen = set()
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    qid = r.get("question_id")
                    if qid in seen:
                        continue
                    seen.add(qid)
                    recs.append(r)
            if recs:
                data[(model, mode)] = recs
    return data


def acc(recs: list[dict[str, Any]]) -> float:
    if not recs:
        return 0.0
    return 100.0 * sum(1 for r in recs if r.get("correct")) / len(recs)


def n_correct(recs: list[dict[str, Any]], diff: str | None = None) -> tuple[int, int]:
    sel = [r for r in recs if diff is None or r.get("difficulty") == diff]
    return sum(1 for r in sel if r.get("correct")), len(sel)


def classify_failure(r: dict[str, Any], mode: str) -> str | None:
    """Failure category for an incorrect record, mirroring the paper's
    step-limit / execution-error / wrong-interpretation decomposition."""
    if r.get("correct"):
        return None
    if r.get("timed_out") or r.get("answer") not in {"A", "B", "C", "D"}:
        return "timeout"
    if mode == "code_generation":
        rc = r.get("exec_rc")
        if rc is None or rc != 0 or not r.get("code_chars"):
            return "exec_error"
        return "wrong_interp"
    if mode == "agent":
        if r.get("errors"):
            return "exec_error"
        if not r.get("tool_calls"):
            return "no_tool_use"
        return "wrong_interp"
    return "wrong_answer"


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------

MODEL_COLORS = {
    "gpt-5.2": "#2e7d32",
    "claude-4.5-sonnet": "#c62828",
    "gemini-3-flash": "#1565c0",
    "grok-4.3": "#8d6e63",
    "grok-4.5-xhigh": "#00897b",
    "composer-2.5": "#6a1b9a",
    "claude-opus-4-8": "#ef6c00",
}


def fig_ladder(data) -> str:
    fig, ax = plt.subplots(figsize=(6.2, 4.0), dpi=200)
    x = np.arange(len(MODES))
    for i, model in enumerate(MODELS):
        ys = []
        for mode in MODES:
            recs = data.get((model, mode))
            ys.append(acc(recs) if recs else np.nan)
        ax.plot(x, ys, marker="o", label=MODEL_NAMES[model],
                color=MODEL_COLORS[model], linewidth=2)
        if not np.isnan(ys[-1]):
            # Stagger endpoint labels; the curves converge near 100%.
            ax.annotate(f"{ys[-1]:.1f}%", (x[-1], ys[-1]),
                        textcoords="offset points", xytext=(10, 8 - 11 * i),
                        fontsize=8, color=MODEL_COLORS[model])
    ax.set_xticks(x)
    ax.set_xticklabels([MODE_NAMES[m] for m in MODES])
    ax.set_xlabel("Interface complexity →")
    ax.set_ylabel("Accuracy (%)")
    ax.set_ylim(0, 100)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="lower right")
    ax.set_title("Accuracy along the interface-complexity ladder")
    path = os.path.join(FIG_DIR, "fig_ladder.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_delta_heatmap(data) -> str:
    """Per-difficulty delta (agent - no_tool), models x difficulty."""
    mat = np.full((len(MODELS), len(DIFFS)), np.nan)
    for i, model in enumerate(MODELS):
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not nt or not ag:
            continue
        for j, d in enumerate(DIFFS):
            c1, t1 = n_correct(nt, d)
            c2, t2 = n_correct(ag, d)
            if t1 and t2:
                mat[i, j] = c2 - c1
    fig, ax = plt.subplots(figsize=(5.4, 3.4), dpi=200)
    vmax = max(5.0, np.nanmax(np.abs(mat)) if not np.all(np.isnan(mat)) else 5.0)
    im = ax.imshow(mat, cmap="RdYlGn", vmin=-vmax, vmax=vmax, aspect="auto")
    ax.set_xticks(range(len(DIFFS)))
    ax.set_xticklabels(DIFFS)
    ax.set_yticks(range(len(MODELS)))
    ax.set_yticklabels([MODEL_NAMES[m] for m in MODELS], fontsize=8)
    for i in range(len(MODELS)):
        for j in range(len(DIFFS)):
            if not np.isnan(mat[i, j]):
                ax.text(j, i, f"{mat[i, j]:+.0f}", ha="center", va="center",
                        fontsize=9, fontweight="bold")
    ax.set_xlabel("Difficulty tier")
    ax.set_title("Δ correct (agent − no-tool), out of 50 per tier")
    fig.colorbar(im, ax=ax, shrink=0.85, label="Δ (questions)")
    path = os.path.join(FIG_DIR, "fig_delta_heatmap.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_category_delta(data) -> str:
    cat_delta: dict[str, list[float]] = defaultdict(list)
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not nt or not ag:
            continue
        nt_by_cat: dict[str, list] = defaultdict(list)
        ag_by_cat: dict[str, list] = defaultdict(list)
        for r in nt:
            nt_by_cat[r.get("category", "?")].append(r)
        for r in ag:
            ag_by_cat[r.get("category", "?")].append(r)
        for cat in nt_by_cat:
            if cat in ag_by_cat and len(nt_by_cat[cat]) >= 3:
                cat_delta[cat].append(acc(ag_by_cat[cat]) - acc(nt_by_cat[cat]))
    cats = sorted(cat_delta, key=lambda c: np.mean(cat_delta[c]))
    if not cats:
        return ""
    means = [np.mean(cat_delta[c]) for c in cats]
    fig, ax = plt.subplots(figsize=(6.4, max(3.0, 0.28 * len(cats))), dpi=200)
    colors = ["#2e7d32" if m >= 0 else "#c62828" for m in means]
    ax.barh(range(len(cats)), means, color=colors, alpha=0.85)
    ax.set_yticks(range(len(cats)))
    ax.set_yticklabels(cats, fontsize=7)
    ax.set_xlabel("Δ accuracy pts (agent − no-tool), mean over models")
    ax.axvline(0, color="k", linewidth=0.8)
    ax.grid(axis="x", alpha=0.3)
    ax.set_title("Where tools help: per-category tool benefit")
    path = os.path.join(FIG_DIR, "fig_category_delta.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_difficulty_modes(data) -> str:
    """Mean accuracy by difficulty tier and mode, averaged over models."""
    fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=200)
    x = np.arange(len(DIFFS))
    w = 0.25
    colors = {"no_tool": "#888888", "code_generation": "#1565c0", "agent": "#2e7d32"}
    for j, mode in enumerate(MODES):
        ys = []
        for diff in DIFFS:
            accs = []
            for model in MODELS:
                recs = data.get((model, mode))
                if recs:
                    c, t = n_correct(recs, diff)
                    if t:
                        accs.append(100.0 * c / t)
            ys.append(np.mean(accs) if accs else 0.0)
        ax.bar(x + (j - 1) * w, ys, w, label=MODE_NAMES[mode],
               color=colors[mode], alpha=0.88)
    ax.set_xticks(x)
    ax.set_xticklabels(DIFFS)
    ax.set_ylabel("Mean accuracy (%)")
    ax.set_ylim(0, 105)
    ax.legend(fontsize=8)
    ax.grid(axis="y", alpha=0.3)
    ax.set_title("Mean accuracy by difficulty tier and evaluation mode")
    path = os.path.join(FIG_DIR, "fig_difficulty_modes.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

def build_pdf(data) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    styles = getSampleStyleSheet()
    title_st = ParagraphStyle("T", parent=styles["Title"], fontSize=16, leading=20,
                              spaceAfter=4)
    author_st = ParagraphStyle("A", parent=styles["Normal"], alignment=1, fontSize=9.5,
                               textColor=colors.HexColor("#444444"), spaceAfter=10)
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=13, leading=16,
                        spaceBefore=12, spaceAfter=5,
                        textColor=colors.HexColor("#12263A"))
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=11, leading=14,
                        spaceBefore=8, spaceAfter=4,
                        textColor=colors.HexColor("#12263A"))
    body = ParagraphStyle("P", parent=styles["BodyText"], fontSize=9.6, leading=13,
                          alignment=4, spaceAfter=5)
    caption = ParagraphStyle("Cap", parent=styles["Normal"], fontSize=8.3, leading=10.5,
                             textColor=colors.HexColor("#555555"), spaceBefore=2,
                             spaceAfter=10, alignment=1)
    mono = ParagraphStyle("Mono", parent=styles["Code"], fontName="Courier",
                          fontSize=7.8, leading=10,
                          backColor=colors.HexColor("#F4F7FB"), borderPadding=5)

    def tstyle(header_rows: int = 1, fs: float = 8.0) -> TableStyle:
        return TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), fs),
            ("FONTNAME", (0, 0), (-1, header_rows - 1), "Helvetica-Bold"),
            ("LINEABOVE", (0, 0), (-1, 0), 0.8, colors.black),
            ("LINEBELOW", (0, header_rows - 1), (-1, header_rows - 1), 0.5, colors.black),
            ("LINEBELOW", (0, -1), (-1, -1), 0.8, colors.black),
            ("ALIGN", (2, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ])

    story: list = []

    # ---- headline stats used in the text ----
    overall: dict[tuple[str, str], float] = {}
    for (model, mode), recs in data.items():
        overall[(model, mode)] = acc(recs)
    deltas = {}
    for model in MODELS:
        if (model, "no_tool") in overall and (model, "agent") in overall:
            deltas[model] = overall[(model, "agent")] - overall[(model, "no_tool")]
    best = max(overall.items(), key=lambda kv: kv[1]) if overall else None
    n_q = max((len(r) for r in data.values()), default=0)

    with open(CIRCUIT_FILE, "r", encoding="utf-8") as f:
        circ = json.load(f)
    n_bus = 8
    n_gen = len(circ.get("GENERATORS", []))
    n_load = len(circ.get("LOADS", []))
    n_line = len(circ.get("LINES", []))

    # ---- Title + abstract ----
    story.append(Paragraph(
        "VeraGridAgent: A Solver-Verified Benchmark for Agentic "
        "Power-System Computation", title_st))
    story.append(Paragraph(
        "Shivanshu Tripathi &nbsp;&middot;&nbsp; University of California, Riverside "
        "&nbsp;&middot;&nbsp; strip008@ucr.edu", author_st))

    gain_txt = []
    loss_txt = []
    for m in MODELS:
        if m in deltas:
            (gain_txt if deltas[m] >= 0 else loss_txt).append(
                f"{MODEL_NAMES[m]} ({deltas[m]:+.1f} pts)")
    abstract = (
        f"Answering quantitative questions about an AC optimal power flow (AC-OPF) "
        f"solution requires numerical computation that language models cannot reliably "
        f"perform from parametric knowledge alone. We present a solver-verified "
        f"benchmark of {n_q} multiple-choice questions on the AC-OPF solution of an "
        f"{n_bus}-bus / {n_gen}-generator / {n_line}-line test system, generated from "
        f"deterministic templates with ground truth fixed by the VeraGrid "
        f"(VeraGridEngine) reference solver. Each of {len(MODELS)} model families is evaluated "
        f"at three levels of tool access forming an interface-complexity ladder: "
        f"no-tool chain-of-thought, single-shot code generation executed in the "
        f"reference environment, and a full tool-augmented agent loop with shell and "
        f"file access to the reference AC-OPF runner. "
    )
    if gain_txt:
        abstract += "Tool access improves " + ", ".join(gain_txt) + ". "
    if loss_txt:
        abstract += "It degrades " + ", ".join(loss_txt) + ". "
    if best:
        abstract += (f"The best configuration, {MODEL_NAMES[best[0][0]]} in "
                     f"{MODE_NAMES[best[0][1]].lower()} mode, reaches {best[1]:.1f}%.")
    story.append(Paragraph("<b>Abstract</b> — " + abstract, body))

    # ---- 1. Benchmark ----
    story.append(Paragraph("1&nbsp;&nbsp;The Benchmark", h1))
    story.append(Paragraph(
        f"The system under study is an {n_bus}-bus meshed network with {n_gen} "
        f"generators (quadratic costs c(P) = a&middot;P&sup2; + b&middot;P with P in "
        f"per-unit on the 100 MVA base), {n_load} loads totalling 185 MW / 70 MVAr, "
        f"and {n_line} lines. The reference AC-OPF dispatch totals 185.7954 MW at a "
        f"total cost of 39.8718, with 0.7954 MW of losses. Questions are generated "
        f"programmatically from deterministic templates over the solved OPF state and "
        f"span 30 categories (branch flows, losses, per-unit conversions, economic "
        f"dispatch, reserves, power factors, voltage quality, cost distribution, ...), "
        f"stratified into three difficulty tiers of 50 questions each: Easy (direct "
        f"lookups), Medium (single-step derived quantities) and Hard (multi-step "
        f"analytical/economic quantities). Each question has four options (A–D); "
        f"distractors are multiplicative perturbations of the correct value, so "
        f"options cannot be rejected by order-of-magnitude reasoning alone. Every "
        f"answer is deterministic and independently verifiable by re-running the "
        f"reference solver.", body))

    story.append(Paragraph("2&nbsp;&nbsp;Evaluation Modes", h1))
    story.append(Paragraph(
        "<b>No-tool access.</b> The model receives the full circuit model (topology, "
        "impedances, loads, generator limits and cost coefficients) and the question, "
        "and must answer from reasoning alone under a strict no-tool directive.", body))
    story.append(Paragraph(
        "<b>Code generation.</b> The model writes exactly one self-contained Python "
        "script. The script is executed once in the reference environment (Python "
        "3.12, numpy/scipy/VeraGridEngine, the circuit JSON, and a run_opf.py wrapper "
        "for the reference AC-OPF). The model then observes stdout/stderr and picks "
        "the closest option. No iteration is allowed.", body))
    story.append(Paragraph(
        "<b>Tool-augmented agent.</b> A full agent loop (cursor-agent harness) with "
        "shell and file tools in a workspace seeded with the circuit model and the "
        "reference AC-OPF runner. The agent may run the solver, read the results "
        "JSON, compute derived quantities, and self-correct on errors before "
        "committing to an option.", body))
    story.append(Paragraph(
        f"All {len(MODELS) * len(MODES)} model–mode combinations use identical questions, circuit "
        "context and answer-extraction rules. Timeouts: 300 s (no-tool), 360+240+180 s "
        "(code generation write/execute/pick), 480 s (agent). Timed-out or unparseable "
        "trajectories are scored as incorrect, mirroring the hidden-E convention of "
        "MathAgent-style benchmarks.", body))

    # ---- 3. Results table ----
    story.append(Paragraph("3&nbsp;&nbsp;Results", h1))
    rows = [["Model", "Mode", "Easy", "Medium", "Hard", "Overall"]]
    span_cmds = []
    r_i = 1
    for model in MODELS:
        first_row = r_i
        for mode in MODES:
            recs = data.get((model, mode))
            if not recs:
                continue
            e = n_correct(recs, "Easy")
            m = n_correct(recs, "Medium")
            h = n_correct(recs, "Hard")
            rows.append([
                MODEL_NAMES[model] if r_i == first_row else "",
                MODE_NAMES[mode],
                f"{e[0]}/{e[1]}", f"{m[0]}/{m[1]}", f"{h[0]}/{h[1]}",
                f"{acc(recs):.1f}%",
            ])
            r_i += 1
        nt, ag = data.get((model, "no_tool")), data.get((model, "agent"))
        if nt and ag:
            de = n_correct(ag, "Easy")[0] - n_correct(nt, "Easy")[0]
            dm = n_correct(ag, "Medium")[0] - n_correct(nt, "Medium")[0]
            dh = n_correct(ag, "Hard")[0] - n_correct(nt, "Hard")[0]
            rows.append(["", "Δ (agent − no tool)", f"{de:+d}", f"{dm:+d}",
                         f"{dh:+d}", f"{acc(ag)-acc(nt):+.1f}"])
            r_i += 1
    t = Table(rows, colWidths=[3.6 * cm, 3.4 * cm, 2.1 * cm, 2.1 * cm, 2.1 * cm, 2.2 * cm], repeatRows=1)
    ts = tstyle()
    # light separator between model blocks + italic delta rows
    for i, row in enumerate(rows):
        if row[1].startswith("Δ"):
            ts.add("FONTNAME", (1, i), (-1, i), "Helvetica-Oblique")
            ts.add("LINEBELOW", (0, i), (-1, i), 0.4, colors.HexColor("#999999"))
    t.setStyle(ts)
    story.append(t)
    story.append(Paragraph(
        "Table 1: Accuracy across all model–mode combinations (correct/total per "
        "difficulty tier). Δ rows show the change from no-tool to agent mode.",
        caption))

    if os.path.exists(os.path.join(FIG_DIR, "fig_ladder.png")):
        story.append(Image(os.path.join(FIG_DIR, "fig_ladder.png"),
                           width=12.6 * cm, height=8.1 * cm))
        story.append(Paragraph(
            "Figure 1: Accuracy along the interface-complexity ladder "
            "(no tool → single-shot code generation → full agent loop).",
            caption))

    # ---- 3.1 Gain/loss/retention ----
    story.append(Paragraph("3.1&nbsp;&nbsp;Gain, Loss, and Retention", h2))
    story.append(Paragraph(
        "Table 4 decomposes each model's tool-mode outcomes relative to the no-tool baseline. "
        "<i>Gained</i> counts items wrong without tools but correct with tools; "
        "<i>lost</i> counts the reverse; <i>retention</i> is the fraction of no-tool-correct "
        "items that remain correct under the richer interface.", body))

    def retention_row(model: str, tool_recs, tool_name: str) -> list[str]:
        nt = data.get((model, "no_tool"))
        if not nt or not tool_recs:
            return []
        nt_ok = {r["question_id"] for r in nt if r.get("correct")}
        tr_ok = {r["question_id"] for r in tool_recs if r.get("correct")}
        direct = len(nt_ok)
        gained = len(tr_ok - nt_ok)
        lost = len(nt_ok - tr_ok)
        retained = len(nt_ok & tr_ok)
        ret_pct = 100.0 * retained / direct if direct else 0.0
        return [
            MODEL_NAMES[model], tool_name, str(direct), str(gained), str(lost),
            str(retained), f"{ret_pct:.1f}%", f"{acc(tool_recs) - acc(nt):+.1f}",
        ]

    rows4 = [["Model", "Tool mode", "Direct right", "Gained", "Lost",
              "Retained", "Retention", "Δ acc (pp)"]]
    for model in MODELS:
        for mode, label in [("code_generation", "Code gen"), ("agent", "Agent")]:
            recs = data.get((model, mode))
            row = retention_row(model, recs, label)
            if row:
                rows4.append(row)
    t4 = Table(rows4, colWidths=[2.8 * cm, 1.8 * cm, 1.9 * cm, 1.5 * cm, 1.5 * cm,
                                 1.7 * cm, 1.7 * cm, 1.5 * cm], repeatRows=1)
    t4.setStyle(tstyle(fs=7.2))
    story.append(t4)
    story.append(Paragraph(
        "Table 4: Gain/loss/retention relative to each model's no-tool baseline.",
        caption))

    # ---- 3.2 Cost efficiency ----
    story.append(Paragraph("3.2&nbsp;&nbsp;Cost Efficiency", h2))
    story.append(Paragraph(
        "Table 5 reports wall-clock seconds per correct answer (total elapsed time divided "
        "by number of correct items). This complements accuracy by showing the operational "
        "cost of grounded computation.", body))
    rows5 = [["Model", "Mode", "Total time (s)", "Correct", "Sec/correct", "Accuracy"]]
    for model in MODELS:
        for mode in MODES:
            recs = data.get((model, mode))
            if not recs:
                continue
            n_corr = sum(1 for r in recs if r.get("correct"))
            total_t = sum(r.get("elapsed_s", 0) or 0 for r in recs)
            spc = total_t / n_corr if n_corr else float("inf")
            rows5.append([
                MODEL_NAMES[model], MODE_NAMES[mode],
                f"{total_t:.0f}", str(n_corr),
                f"{spc:.1f}" if n_corr else "—", f"{acc(recs):.1f}%",
            ])
    t5 = Table(rows5, colWidths=[3.0 * cm, 2.2 * cm, 2.4 * cm, 1.6 * cm, 2.2 * cm, 2.0 * cm],
               repeatRows=1)
    t5.setStyle(tstyle(fs=7.2))
    story.append(t5)
    story.append(Paragraph("Table 5: Wall-clock cost efficiency by model and mode.", caption))

    if os.path.exists(os.path.join(FIG_DIR, "fig_difficulty_modes.png")):
        story.append(Image(os.path.join(FIG_DIR, "fig_difficulty_modes.png"),
                           width=12.6 * cm, height=7.8 * cm))
        story.append(Paragraph(
            "Figure 2: Accuracy by difficulty tier and evaluation mode (mean over models).",
            caption))

    # ---- 4. Failure decomposition ----
    story.append(PageBreak())
    story.append(Paragraph("4&nbsp;&nbsp;Failure-Mode Decomposition", h1))
    frows = [["Model", "Mode", "Timeout /\nno answer", "Exec\nerror",
              "No tool\nuse", "Wrong\ninterp.", "Total\nerrors"]]
    for model in MODELS:
        for mode in ("code_generation", "agent"):
            recs = data.get((model, mode))
            if not recs:
                continue
            cats = defaultdict(int)
            for r in recs:
                c = classify_failure(r, mode)
                if c:
                    cats[c] += 1
            frows.append([
                MODEL_NAMES[model], MODE_NAMES[mode],
                str(cats.get("timeout", 0)), str(cats.get("exec_error", 0)),
                str(cats.get("no_tool_use", 0)) if mode == "agent" else "—",
                str(cats.get("wrong_interp", 0)),
                str(sum(cats.values())),
            ])
    ft = Table(frows, colWidths=[3.6 * cm, 2.6 * cm, 2.2 * cm, 1.8 * cm,
                                 1.8 * cm, 1.9 * cm, 1.8 * cm])
    ft.setStyle(tstyle())
    story.append(ft)
    story.append(Paragraph(
        "Table 2: Error decomposition for the tool-using modes. "
        "<i>Timeout/no answer</i>: the trajectory exceeded its wall-clock budget or "
        "produced no parseable option. <i>Exec error</i>: code or tool invocations "
        "failed. <i>No tool use</i>: the agent answered from memory despite the "
        "tool-first instruction and was wrong. <i>Wrong interp.</i>: code or tool "
        "calls executed successfully but the submitted answer was incorrect — "
        "the faulty problem-to-code translation mode.", caption))

    if os.path.exists(os.path.join(FIG_DIR, "fig_delta_heatmap.png")):
        story.append(Image(os.path.join(FIG_DIR, "fig_delta_heatmap.png"),
                           width=11.6 * cm, height=7.3 * cm))
        story.append(Paragraph(
            "Figure 3: Per-difficulty-tier Δ (agent − no-tool) for each "
            "model, out of 50 questions per tier.", caption))

    if os.path.exists(os.path.join(FIG_DIR, "fig_category_delta.png")):
        from reportlab.lib.utils import ImageReader
        cat_png = os.path.join(FIG_DIR, "fig_category_delta.png")
        iw, ih = ImageReader(cat_png).getSize()
        w = 13.2 * cm
        h = w * ih / iw
        max_h = 19.0 * cm
        if h > max_h:
            w, h = max_h * iw / ih, max_h
        story.append(PageBreak())
        story.append(Image(cat_png, width=w, height=h))
        story.append(Paragraph(
            "Figure 4: Mean per-category tool benefit (agent − no-tool accuracy, "
            "averaged over models; categories with ≥ 3 questions).", caption))

    # ---- 5.1 Hardest remaining items ----
    story.append(Paragraph("5.1&nbsp;&nbsp;Hardest Remaining Items (Agent Mode)", h2))
    fail_counts: dict[int, int] = defaultdict(int)
    fail_meta: dict[int, dict] = {}
    for model in MODELS:
        for r in data.get((model, "agent"), []):
            if not r.get("correct"):
                qid = r["question_id"]
                fail_counts[qid] += 1
                fail_meta[qid] = r
    hard_rows = [["QID", "Difficulty", "Category", "Models failed", "Expected"]]
    for qid, cnt in sorted(fail_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:15]:
        m = fail_meta[qid]
        hard_rows.append([
            str(qid), m.get("difficulty", "?"), m.get("category", "?"),
            f"{cnt}/{len(MODELS)}", m.get("expected", "?"),
        ])
    if len(hard_rows) > 1:
        ht = Table(hard_rows, colWidths=[1.4 * cm, 2.2 * cm, 4.8 * cm, 2.4 * cm, 1.6 * cm],
                   repeatRows=1)
        ht.setStyle(tstyle(fs=7.5))
        story.append(ht)
        story.append(Paragraph(
            "Table 6: Questions missed most often in agent mode (up to 15 rows). "
            "Items with 0 agent failures across all models are omitted.",
            caption))
    else:
        story.append(Paragraph(
            "All models answered every agent-mode question correctly in at least one run; "
            "no cross-model hard core remains at full accuracy.", body))

    # ---- 5. Category table (agent mode, per model) ----
    story.append(PageBreak())
    story.append(Paragraph("5&nbsp;&nbsp;Per-Category Accuracy (Agent Mode)", h1))
    cat_counts: dict[str, int] = defaultdict(int)
    for recs in data.values():
        for r in recs:
            cat_counts[r.get("category", "?")] += 1
        break
    any_recs = next(iter(data.values()), [])
    cat_totals: dict[str, int] = defaultdict(int)
    for r in any_recs:
        cat_totals[r.get("category", "?")] += 1
    cats_sorted = sorted(cat_totals, key=lambda c: -cat_totals[c])
    crows = [["Category", "N"] + [MODEL_NAMES[m] for m in MODELS]]
    for cat in cats_sorted:
        row = [cat, str(cat_totals[cat])]
        for model in MODELS:
            recs = data.get((model, "agent"))
            if not recs:
                row.append("—")
                continue
            sel = [r for r in recs if r.get("category") == cat]
            row.append(f"{sum(1 for r in sel if r.get('correct'))}/{len(sel)}"
                       if sel else "—")
        crows.append(row)
    ct = Table(crows, colWidths=[4.6 * cm, 1.0 * cm] + [2.6 * cm] * len(MODELS), repeatRows=1)
    cts = tstyle()
    cts.add("FONTSIZE", (0, 0), (-1, -1), 7.2)
    ct.setStyle(cts)
    story.append(ct)
    story.append(Paragraph(
        "Table 3: Agent-mode accuracy per question category (correct/total).",
        caption))

    # ---- 6. Example trajectories ----
    story.append(PageBreak())
    story.append(Paragraph("6&nbsp;&nbsp;Example Trajectories", h1))

    def fmt_example(r: dict[str, Any], title: str) -> None:
        story.append(Paragraph(f"<b>{title}</b>", h2))
        txt = (f"Q{r.get('question_id')} [{r.get('difficulty')}, "
               f"{r.get('category')}] — model {MODEL_NAMES.get(r.get('model'), r.get('model'))}, "
               f"mode {MODE_NAMES.get(r.get('mode'), r.get('mode'))}: answered "
               f"<b>{r.get('answer')}</b>, expected <b>{r.get('expected')}</b> "
               f"({'correct' if r.get('correct') else 'incorrect'}); "
               f"tool calls: {r.get('tool_calls', 0)}, elapsed {r.get('elapsed_s', 0):.0f} s.")
        story.append(Paragraph(txt, body))
        raw = (r.get("raw") or "").replace("&", "&amp;").replace("<", "&lt;")
        if raw:
            story.append(Paragraph("Final transcript tail: " + raw[:600], mono))
        story.append(Spacer(1, 6))

    # success with tools
    ex1 = next((r for m in MODELS for r in data.get((m, "agent"), [])
                if r.get("correct") and r.get("tool_calls", 0) > 0
                and r.get("difficulty") == "Hard"), None)
    ex2 = next((r for m in MODELS for r in data.get((m, "agent"), [])
                if not r.get("correct") and classify_failure(r, "agent") == "wrong_interp"), None)
    if ex1:
        fmt_example(ex1, "Successful tool-grounded trajectory")
    if ex2:
        fmt_example(ex2, "Wrong-interpretation failure (tools ran, answer wrong)")

    # ---- 7. Notes ----
    story.append(Paragraph("7&nbsp;&nbsp;Notes and Limitations", h1))
    fable_note = ""
    if ("claude-opus-4-8", "no_tool") in data:
        fable_note = (
            " <b>Harness note for Opus 4.8:</b> unlike the other models, which run "
            "through the cursor-agent CLI, Opus 4.8 is served through the Claude Code "
            "CLI (a Claude subscription), because cursor-agent was rate-limited. "
            "The two harnesses differ in system-prompt scaffolding and tool "
            "implementations, so Opus 4.8's absolute accuracies are not a strictly "
            "apples-to-apples comparison with the other models; its within-model "
            "ladder (no-tool → code-gen → agent) remains internally consistent. In "
            "agent mode Opus 4.8 used the Claude Code Bash/Read tools against the same "
            "seeded run_opf.py reference solver.")
    story.append(Paragraph(
        "Models are accessed through the cursor-agent CLI harness, so absolute "
        "accuracies reflect that serving stack (including its internal reasoning "
        "budgets) rather than provider-native APIs. The four-option MCQ format has a "
        "25% random-guess floor. The benchmark uses a single 8-bus circuit; "
        "conclusions about tool benefit are therefore per-domain (per question "
        "category and difficulty tier) rather than cross-circuit. Ground truth was "
        "re-verified before the run by re-executing the VeraGrid reference AC-OPF "
        "and matching the stored solution exactly." + fable_note, body))

    doc = SimpleDocTemplate(PDF_PATH, pagesize=A4,
                            leftMargin=2.0 * cm, rightMargin=2.0 * cm,
                            topMargin=1.6 * cm, bottomMargin=1.6 * cm,
                            title="VeraGridAgent Benchmark Report",
                            author="Shivanshu Tripathi")
    doc.build(story)


def print_summary(data) -> None:
    print(f"{'Model':<20} {'Mode':<16} {'Easy':>7} {'Med':>7} {'Hard':>7} {'Overall':>9}")
    for model in MODELS:
        for mode in MODES:
            recs = data.get((model, mode))
            if not recs:
                continue
            e = n_correct(recs, "Easy")
            m = n_correct(recs, "Medium")
            h = n_correct(recs, "Hard")
            print(f"{model:<20} {mode:<16} {e[0]:>3}/{e[1]:<3} {m[0]:>3}/{m[1]:<3} "
                  f"{h[0]:>3}/{h[1]:<3} {acc(recs):>8.1f}%")


def main() -> int:
    os.makedirs(FIG_DIR, exist_ok=True)
    data = load_records()
    if not data:
        print("No result files found in", RAW_DIR)
        return 1
    print_summary(data)
    fig_ladder(data)
    fig_delta_heatmap(data)
    fig_category_delta(data)
    fig_difficulty_modes(data)
    build_pdf(data)
    print(f"\n[DONE] PDF report: {PDF_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
