#!/usr/bin/env python3
"""
VeraGrid MCQ Benchmark — supplementary appendix PDF.

Mirrors the appendix analyses in PHREEQC-MCQ-200 (arXiv:2607.00436), adapted to
the VeraGrid 150-question AC-OPF benchmark and its three evaluation modes
(no-tool, code generation, tool-augmented agent).

Run:
  /Users/shivanshutripathi/PSCAD/.venv312/bin/python benchmark_appendix_report.py
"""

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from benchmark_report import (
    CIRCUIT_FILE,
    DIFFS,
    FIG_DIR,
    MODELS,
    MODEL_NAMES,
    MODES,
    MODE_NAMES,
    OUT_DIR,
    QUESTIONS_FILE,
    RAW_DIR,
    acc,
    classify_failure,
    load_records,
    n_correct,
)

APPENDIX_FIG_DIR = os.path.join(FIG_DIR, "appendix")
PDF_PATH = os.path.join(OUT_DIR, "veragrid_llm_benchmark_appendix.pdf")
LABELS = ["A", "B", "C", "D"]


def truth_distribution(recs: list[dict[str, Any]]) -> Counter[str]:
    return Counter(r.get("expected", "?") for r in recs)


def predicted_distribution(recs: list[dict[str, Any]]) -> Counter[str]:
    c: Counter[str] = Counter({lab: 0 for lab in LABELS})
    na = 0
    for r in recs:
        ans = r.get("answer")
        if ans in LABELS:
            c[ans] += 1
        else:
            na += 1
    c["NA"] = na
    return c


def per_label_accuracy(recs: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for lab in LABELS:
        sel = [r for r in recs if r.get("expected") == lab]
        if sel:
            out[lab] = 100.0 * sum(1 for r in sel if r.get("correct")) / len(sel)
    return out


def label_range_str(recs: list[dict[str, Any]]) -> str:
    vals = list(per_label_accuracy(recs).values())
    if not vals:
        return "—"
    return f"{min(vals):.1f}–{max(vals):.1f}%"


def pred_label_str(recs: list[dict[str, Any]]) -> str:
    c = predicted_distribution(recs)
    return "/".join(str(c.get(l, 0)) for l in LABELS) + f"/{c.get('NA', 0)}"


def retention_stats(
    baseline: list[dict[str, Any]], tool: list[dict[str, Any]]
) -> dict[str, Any]:
    b_by_id = {r["question_id"]: r for r in baseline}
    t_by_id = {r["question_id"]: r for r in tool}
    ids = sorted(set(b_by_id) & set(t_by_id))
    direct_right = [i for i in ids if b_by_id[i].get("correct")]
    gained = [i for i in ids if not b_by_id[i].get("correct") and t_by_id[i].get("correct")]
    lost = [i for i in direct_right if not t_by_id[i].get("correct")]
    retained = [i for i in direct_right if t_by_id[i].get("correct")]
    return {
        "direct_right": len(direct_right),
        "gained": len(gained),
        "lost": len(lost),
        "retained": len(retained),
        "retention_rate": (100.0 * len(retained) / len(direct_right)) if direct_right else 0.0,
        "lost_ids": lost,
        "gained_ids": gained,
    }


def overlap_partition(
    a: list[dict[str, Any]], b: list[dict[str, Any]]
) -> dict[str, int]:
    a_ok = {r["question_id"] for r in a if r.get("correct")}
    b_ok = {r["question_id"] for r in b if r.get("correct")}
    both = a_ok & b_ok
    a_only = a_ok - b_ok
    b_only = b_ok - a_ok
    neither = set(r["question_id"] for r in a) - a_ok - b_ok
    return {
        "a_right": len(a_ok),
        "b_right": len(b_ok),
        "both": len(both),
        "a_only": len(a_only),
        "b_only": len(b_only),
        "neither": len(neither),
    }


def three_way_partition(
    nt: list[dict[str, Any]], cg: list[dict[str, Any]], ag: list[dict[str, Any]]
) -> dict[str, int]:
    nt_ok = {r["question_id"] for r in nt if r.get("correct")}
    cg_ok = {r["question_id"] for r in cg if r.get("correct")}
    ag_ok = {r["question_id"] for r in ag if r.get("correct")}
    all_ids = set(r["question_id"] for r in nt)
    counts = Counter()
    for qid in all_ids:
        flags = (qid in nt_ok, qid in cg_ok, qid in ag_ok)
        n = sum(flags)
        if n == 3:
            counts["all_three"] += 1
        elif n == 0:
            counts["none"] += 1
        elif flags == (True, False, False):
            counts["nt_only"] += 1
        elif flags == (False, True, False):
            counts["cg_only"] += 1
        elif flags == (False, False, True):
            counts["ag_only"] += 1
        elif flags == (True, True, False):
            counts["nt_cg"] += 1
        elif flags == (True, False, True):
            counts["nt_ag"] += 1
        elif flags == (False, True, True):
            counts["cg_ag"] += 1
    return dict(counts)


def lost_by_difficulty(
    baseline: list[dict[str, Any]], tool: list[dict[str, Any]]
) -> dict[str, float]:
    b_by_id = {r["question_id"]: r for r in baseline}
    t_by_id = {r["question_id"]: r for r in tool}
    rates: dict[str, float] = {}
    for diff in DIFFS + ["overall"]:
        if diff == "overall":
            direct = [i for i, r in b_by_id.items() if r.get("correct")]
        else:
            direct = [
                i for i, r in b_by_id.items()
                if r.get("correct") and r.get("difficulty") == diff
            ]
        if not direct:
            rates[diff] = float("nan")
            continue
        lost = sum(1 for i in direct if not t_by_id.get(i, {}).get("correct"))
        rates[diff] = 100.0 * lost / len(direct)
    return rates


def lost_by_category(
    baseline: list[dict[str, Any]], tool: list[dict[str, Any]]
) -> dict[str, tuple[int, int, float]]:
    b_by_id = {r["question_id"]: r for r in baseline}
    t_by_id = {r["question_id"]: r for r in tool}
    cat_direct: dict[str, list[int]] = defaultdict(list)
    cat_lost: dict[str, int] = defaultdict(int)
    for qid, r in b_by_id.items():
        if r.get("correct"):
            cat_direct[r.get("category", "?")].append(qid)
    for cat, qids in cat_direct.items():
        for qid in qids:
            if not t_by_id.get(qid, {}).get("correct"):
                cat_lost[cat] += 1
    out = {}
    for cat, qids in cat_direct.items():
        out[cat] = (cat_lost[cat], len(qids), 100.0 * cat_lost[cat] / len(qids))
    return out


def lost_by_truth_label(
    baseline: list[dict[str, Any]], tool: list[dict[str, Any]]
) -> dict[str, tuple[int, int]]:
    b_by_id = {r["question_id"]: r for r in baseline}
    t_by_id = {r["question_id"]: r for r in tool}
    lost = Counter()
    direct = Counter()
    for qid, r in b_by_id.items():
        if r.get("correct"):
            lab = r.get("expected", "?")
            direct[lab] += 1
            if not t_by_id.get(qid, {}).get("correct"):
                lost[lab] += 1
    return {lab: (lost[lab], direct[lab]) for lab in LABELS}


def category_grid(data, mode: str = "agent") -> tuple[list[str], dict[str, dict[str, float]]]:
    """Per-category accuracy per model for a given mode."""
    cats: set[str] = set()
    for recs in data.values():
        for r in recs:
            cats.add(r.get("category", "?"))
    cats_sorted = sorted(cats)
    grid: dict[str, dict[str, float]] = {}
    for model in MODELS:
        recs = data.get((model, mode))
        if not recs:
            continue
        by_cat: dict[str, list] = defaultdict(list)
        for r in recs:
            by_cat[r.get("category", "?")].append(r)
        grid[model] = {c: acc(by_cat[c]) if by_cat[c] else float("nan") for c in cats_sorted}
    return cats_sorted, grid


def trajectory_stats(recs: list[dict[str, Any]]) -> dict[str, float]:
    elapsed = [r.get("elapsed_s", 0) or 0 for r in recs]
    tools = [r.get("tool_calls", 0) or 0 for r in recs]
    shells = [r.get("shell_runs", 0) or 0 for r in recs]
    failed = [r for r in recs if not r.get("correct")]
    f_tools = [r.get("tool_calls", 0) or 0 for r in failed]
    return {
        "wall_med": float(np.median(elapsed)),
        "wall_p90": float(np.percentile(elapsed, 90)),
        "tools_med": float(np.median(tools)),
        "shell_med": float(np.median(shells)),
        "failed_n": len(failed),
        "failed_tools_med": float(np.median(f_tools)) if f_tools else 0.0,
        "failed_tools_mean": float(np.mean(f_tools)) if f_tools else 0.0,
        "overall_tools_med": float(np.median(tools)),
    }


def auto_failure_counts(recs: list[dict[str, Any]], mode: str) -> Counter[str]:
    c: Counter[str] = Counter()
    for r in recs:
        cat = classify_failure(r, mode)
        if cat:
            c[cat] += 1
    return c


def elapsed_by_mode(data) -> dict[tuple[str, str], dict[str, float]]:
    out = {}
    for model in MODELS:
        for mode in MODES:
            recs = data.get((model, mode))
            if not recs:
                continue
            times = [r.get("elapsed_s", 0) or 0 for r in recs]
            n_corr = sum(1 for r in recs if r.get("correct"))
            out[(model, mode)] = {
                "total_s": sum(times),
                "mean_s": float(np.mean(times)),
                "median_s": float(np.median(times)),
                "acc": acc(recs),
                "n_corr": n_corr,
                "sec_per_correct": sum(times) / n_corr if n_corr else float("inf"),
            }
    return out


def code_gen_stats(recs: list[dict[str, Any]]) -> dict[str, float]:
    chars = [r.get("code_chars", 0) or 0 for r in recs]
    exec_ok = sum(1 for r in recs if r.get("exec_rc") == 0 and r.get("code_chars"))
    return {
        "mean_chars": float(np.mean(chars)) if chars else 0.0,
        "median_chars": float(np.median(chars)) if chars else 0.0,
        "exec_ok": exec_ok,
        "n": len(recs),
    }


def agent_failures_by_question(data) -> dict[int, dict[str, Any]]:
    """Count agent-mode failures per question across models."""
    fails: dict[int, list[str]] = defaultdict(list)
    meta: dict[int, dict] = {}
    for model in MODELS:
        for r in data.get((model, "agent"), []):
            if not r.get("correct"):
                qid = r["question_id"]
                fails[qid].append(model)
                meta[qid] = r
    return {qid: {"count": len(models), "models": models, "meta": meta[qid]}
            for qid, models in fails.items()}


def cross_model_agent_agreement(data) -> dict[str, int]:
    """Items all models get right/wrong in agent mode."""
    by_q: dict[int, list[bool]] = defaultdict(list)
    for model in MODELS:
        for r in data.get((model, "agent"), []):
            by_q[r["question_id"]].append(r.get("correct", False))
    all_right = sum(1 for vals in by_q.values() if vals and all(vals))
    all_wrong = sum(1 for vals in by_q.values() if vals and not any(vals))
    mixed = len(by_q) - all_right - all_wrong
    return {"all_right": all_right, "all_wrong": all_wrong, "mixed": mixed}


def no_tool_confusion_matrix(recs: list[dict[str, Any]]) -> dict[tuple[str, str], int]:
    cm: dict[tuple[str, str], int] = defaultdict(int)
    for r in recs:
        pred = r.get("answer")
        truth = r.get("expected")
        if pred in LABELS and truth in LABELS:
            cm[(truth, pred)] += 1
    return cm


def per_difficulty_mode_table(data) -> list[list[str]]:
    rows = [["Difficulty"] + [MODE_NAMES[m] for m in MODES]]
    for diff in DIFFS:
        row = [diff]
        for mode in MODES:
            accs = []
            for model in MODELS:
                recs = data.get((model, mode))
                if recs:
                    c, t = n_correct(recs, diff)
                    if t:
                        accs.append(100.0 * c / t)
            row.append(f"{np.mean(accs):.1f}%" if accs else "—")
        rows.append(row)
    return rows


def category_mode_deltas(data) -> list[tuple[str, float, float, float]]:
    """Mean per-category delta (tool mode − no_tool) averaged over models."""
    cats: set[str] = set()
    for recs in data.values():
        for r in recs:
            cats.add(r.get("category", "?"))
    out = []
    for cat in sorted(cats):
        d_cg, d_ag = [], []
        for model in MODELS:
            nt = data.get((model, "no_tool"))
            cg = data.get((model, "code_generation"))
            ag = data.get((model, "agent"))
            if not nt:
                continue
            def cat_acc(recs):
                sel = [r for r in recs if r.get("category") == cat]
                return acc(sel) if sel else float("nan")
            a0 = cat_acc(nt)
            if cg and not np.isnan(a0):
                a1 = cat_acc(cg)
                if not np.isnan(a1):
                    d_cg.append(a1 - a0)
            if ag and not np.isnan(a0):
                a2 = cat_acc(ag)
                if not np.isnan(a2):
                    d_ag.append(a2 - a0)
        if d_cg or d_ag:
            out.append((
                cat,
                float(np.mean(d_cg)) if d_cg else float("nan"),
                float(np.mean(d_ag)) if d_ag else float("nan"),
            ))
    return sorted(out, key=lambda x: -(x[2] if not np.isnan(x[2]) else x[1]))


def agent_error_details(data) -> list[dict[str, Any]]:
    rows = []
    for model in MODELS:
        for r in data.get((model, "agent"), []):
            if r.get("correct"):
                continue
            rows.append({
                "model": model,
                "qid": r["question_id"],
                "difficulty": r.get("difficulty"),
                "category": r.get("category"),
                "expected": r.get("expected"),
                "answer": r.get("answer"),
                "failure": classify_failure(r, "agent"),
                "tool_calls": r.get("tool_calls", 0),
                "elapsed_s": r.get("elapsed_s", 0),
            })
    return sorted(rows, key=lambda x: (x["qid"], x["model"]))


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------

def fig_retention_heatmap(data) -> str:
    mat = np.full((len(MODELS), len(DIFFS)), np.nan)
    for i, model in enumerate(MODELS):
        nt, ag = data.get((model, "no_tool")), data.get((model, "agent"))
        if not nt or not ag:
            continue
        rates = lost_by_difficulty(nt, ag)
        for j, d in enumerate(DIFFS):
            mat[i, j] = rates.get(d, float("nan"))
    fig, ax = plt.subplots(figsize=(5.4, 3.4), dpi=200)
    vmax = max(5.0, np.nanmax(mat) if not np.all(np.isnan(mat)) else 5.0)
    im = ax.imshow(mat, cmap="Reds", vmin=0, vmax=vmax, aspect="auto")
    ax.set_xticks(range(len(DIFFS)))
    ax.set_xticklabels(DIFFS)
    ax.set_yticks(range(len(MODELS)))
    ax.set_yticklabels([MODEL_NAMES[m] for m in MODELS], fontsize=8)
    for i in range(len(MODELS)):
        for j in range(len(DIFFS)):
            if not np.isnan(mat[i, j]):
                ax.text(j, i, f"{mat[i, j]:.0f}%", ha="center", va="center", fontsize=9)
    ax.set_xlabel("Difficulty tier")
    ax.set_title("Lost-item rate (no-tool correct → agent wrong)")
    fig.colorbar(im, ax=ax, shrink=0.85, label="Lost rate (%)")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_lost_rate_heatmap.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_category_spread(data) -> str:
    cats, grid = category_grid(data, "agent")
    if not grid:
        return ""
    spreads = []
    cat_labels = []
    for cat in cats:
        vals = [grid[m][cat] for m in MODELS if m in grid and not np.isnan(grid[m][cat])]
        if len(vals) >= 2:
            spreads.append(max(vals) - min(vals))
            cat_labels.append(cat)
    if not spreads:
        return ""
    order = np.argsort(spreads)[::-1]
    spreads = [spreads[i] for i in order]
    cat_labels = [cat_labels[i] for i in order]
    fig, ax = plt.subplots(figsize=(6.4, max(3.0, 0.28 * len(cat_labels))), dpi=200)
    ax.barh(range(len(cat_labels)), spreads, color="#1565c0", alpha=0.85)
    ax.set_yticks(range(len(cat_labels)))
    ax.set_yticklabels(cat_labels, fontsize=7)
    ax.set_xlabel("Cross-model spread (max − min agent accuracy, pp)")
    ax.set_title("Per-category capability discrimination (agent mode)")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_category_spread.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_overlap_bars(data) -> str:
    fig, ax = plt.subplots(figsize=(6.2, 4.0), dpi=200)
    x = np.arange(len(MODELS))
    w = 0.25
    for j, (mode, label, color) in enumerate([
        ("no_tool", "No tool only", "#888888"),
        ("code_generation", "Code gen only", "#1565c0"),
        ("agent", "Agent only", "#2e7d32"),
    ]):
        vals = []
        for model in MODELS:
            nt = data.get((model, "no_tool"))
            cg = data.get((model, "code_generation"))
            ag = data.get((model, "agent"))
            if not (nt and cg and ag):
                vals.append(0)
                continue
            part = three_way_partition(nt, cg, ag)
            key = {"no_tool": "nt_only", "code_generation": "cg_only", "agent": "ag_only"}[mode]
            vals.append(part.get(key, 0))
        ax.bar(x + (j - 1) * w, vals, w, label=label, color=color, alpha=0.85)
    ax.set_xticks(x)
    ax.set_xticklabels([MODEL_NAMES[m] for m in MODELS], fontsize=8, rotation=15, ha="right")
    ax.set_ylabel("Items solved by one mode only (of 150)")
    ax.legend(fontsize=8)
    ax.set_title("Mode-exclusive correct items (three-way partition)")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_mode_exclusive.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_efficiency(data) -> str:
    fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=200)
    elapsed = elapsed_by_mode(data)
    x = np.arange(len(MODELS))
    w = 0.25
    for j, mode in enumerate(MODES):
        ys = []
        for model in MODELS:
            st = elapsed.get((model, mode))
            if st and st["n_corr"]:
                ys.append(st["sec_per_correct"])
            else:
                ys.append(np.nan)
        ax.bar(x + (j - 1) * w, ys, w, label=MODE_NAMES[mode],
               color=["#888888", "#1565c0", "#2e7d32"][j], alpha=0.88)
    ax.set_xticks(x)
    ax.set_xticklabels([MODEL_NAMES[m] for m in MODELS], fontsize=7, rotation=15, ha="right")
    ax.set_ylabel("Seconds per correct answer")
    ax.legend(fontsize=8)
    ax.grid(axis="y", alpha=0.3)
    ax.set_title("Wall-clock cost efficiency by mode")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_efficiency.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_hard_questions(data) -> str:
    fails = agent_failures_by_question(data)
    if not fails:
        return ""
    items = sorted(fails.items(), key=lambda kv: -kv[1]["count"])[:20]
    labels = [f"Q{qid}" for qid, _ in items]
    counts = [info["count"] for _, info in items]
    fig, ax = plt.subplots(figsize=(6.4, max(3.0, 0.32 * len(labels))), dpi=200)
    ax.barh(range(len(labels)), counts, color="#c62828", alpha=0.85)
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(labels, fontsize=7)
    ax.set_xlabel(f"Models failed (of {len(MODELS)})")
    ax.set_title("Hardest agent-mode questions (cross-model failures)")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_hard_questions.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_codegen_exec(data) -> str:
    fig, ax = plt.subplots(figsize=(5.4, 3.4), dpi=200)
    exec_rates, labels = [], []
    for model in MODELS:
        recs = data.get((model, "code_generation"))
        if not recs:
            continue
        st = code_gen_stats(recs)
        exec_rates.append(100.0 * st["exec_ok"] / st["n"])
        labels.append(MODEL_NAMES[model])
    ax.bar(range(len(labels)), exec_rates, color="#1565c0", alpha=0.85)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, fontsize=7, rotation=15, ha="right")
    ax.set_ylabel("Exec success (%)")
    ax.set_ylim(0, 105)
    ax.set_title("Code-generation execution success rate")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_codegen_exec.png")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def fig_agent_heatmap(data) -> str:
    """Models × difficulty agent accuracy."""
    mat = np.full((len(MODELS), len(DIFFS)), np.nan)
    for i, model in enumerate(MODELS):
        recs = data.get((model, "agent"))
        if not recs:
            continue
        for j, diff in enumerate(DIFFS):
            c, t = n_correct(recs, diff)
            if t:
                mat[i, j] = 100.0 * c / t
    fig, ax = plt.subplots(figsize=(5.0, 3.6), dpi=200)
    im = ax.imshow(mat, cmap="RdYlGn", vmin=80, vmax=100, aspect="auto")
    ax.set_xticks(range(len(DIFFS)))
    ax.set_xticklabels(DIFFS)
    ax.set_yticks(range(len(MODELS)))
    ax.set_yticklabels([MODEL_NAMES[m] for m in MODELS], fontsize=8)
    for i in range(len(MODELS)):
        for j in range(len(DIFFS)):
            if not np.isnan(mat[i, j]):
                ax.text(j, i, f"{mat[i, j]:.0f}", ha="center", va="center", fontsize=9)
    ax.set_title("Agent-mode accuracy by model and difficulty")
    fig.colorbar(im, ax=ax, shrink=0.85, label="Accuracy (%)")
    path = os.path.join(APPENDIX_FIG_DIR, "fig_agent_heatmap.png")
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
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    styles = getSampleStyleSheet()
    title_st = ParagraphStyle(
        "T", parent=styles["Title"], fontSize=15, leading=19, spaceAfter=4,
    )
    author_st = ParagraphStyle(
        "A", parent=styles["Normal"], alignment=1, fontSize=9.5,
        textColor=colors.HexColor("#444444"), spaceAfter=10,
    )
    h1 = ParagraphStyle(
        "H1", parent=styles["Heading1"], fontSize=12, leading=15,
        spaceBefore=10, spaceAfter=4, textColor=colors.HexColor("#12263A"),
    )
    h2 = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontSize=10.5, leading=13,
        spaceBefore=6, spaceAfter=3, textColor=colors.HexColor("#12263A"),
    )
    body = ParagraphStyle(
        "P", parent=styles["BodyText"], fontSize=9.2, leading=12.5,
        alignment=4, spaceAfter=4,
    )
    caption = ParagraphStyle(
        "Cap", parent=styles["Normal"], fontSize=8.0, leading=10,
        textColor=colors.HexColor("#555555"), spaceBefore=2, spaceAfter=8, alignment=1,
    )

    def tstyle(header_rows: int = 1, fs: float = 7.5) -> TableStyle:
        return TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), fs),
            ("FONTNAME", (0, 0), (-1, header_rows - 1), "Helvetica-Bold"),
            ("LINEABOVE", (0, 0), (-1, 0), 0.8, colors.black),
            ("LINEBELOW", (0, header_rows - 1), (-1, header_rows - 1), 0.5, colors.black),
            ("LINEBELOW", (0, -1), (-1, -1), 0.8, colors.black),
            ("ALIGN", (1, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ])

    any_recs = next(iter(data.values()))
    n_q = len(any_recs)
    truth = truth_distribution(any_recs)
    truth_str = "/".join(str(truth.get(l, 0)) for l in LABELS)

    with open(CIRCUIT_FILE, encoding="utf-8") as f:
        circ = json.load(f)
    n_bus, n_gen, n_line = 8, len(circ.get("GENERATORS", [])), len(circ.get("LINES", []))

    story: list = []
    story.append(Paragraph(
        "Appendix: Supplementary Results for VeraGridAgent", title_st))
    story.append(Paragraph(
        "Shivanshu Tripathi &nbsp;&middot;&nbsp; University of California, Riverside "
        "&nbsp;&middot;&nbsp; strip008@ucr.edu", author_st))
    story.append(Paragraph(
        f"This appendix collects supplementary analyses for the VeraGridAgent benchmark "
        f"({n_q} MCQ items on an {n_bus}-bus AC-OPF solution), structured after the "
        f"appendix of PHREEQC-MCQ-200 [Zhang et al., 2026]. Where the reference paper "
        f"studies TOC vs raw-output access protocols, we substitute the three-mode "
        f"interface-complexity ladder (no-tool, single-shot code generation, tool-augmented "
        f"agent). Truth-label distribution: A/B/C/D = {truth_str}.", body))

    # ---- A: Answer-label behavior ----
    story.append(Paragraph("A&nbsp;&nbsp;Answer-Label Behavior", h1))
    story.append(Paragraph(
        "Table A1 reports predicted-label counts and per-true-label accuracy ranges. "
        "No-tool baselines can show strong answer-position preferences; agent mode typically "
        "flattens predictions toward the benchmark truth distribution.", body))
    rows_a = [["Method", "Predicted A/B/C/D/NA", "Per-true-label acc. range"]]
    for model in MODELS:
        for mode in MODES:
            recs = data.get((model, mode))
            if not recs:
                continue
            rows_a.append([
                f"{MODEL_NAMES[model]} + {MODE_NAMES[mode]}",
                pred_label_str(recs),
                label_range_str(recs),
            ])
    ta = Table(rows_a, colWidths=[4.8 * cm, 5.2 * cm, 4.5 * cm], repeatRows=1)
    ta.setStyle(tstyle(fs=7.0))
    story.append(ta)
    story.append(Paragraph("Table A1: Answer-label behavior across all model–mode combinations.", caption))

    # ---- B: Wall-clock cost ----
    story.append(Paragraph("B&nbsp;&nbsp;Wall-Clock Cost by Evaluation Mode", h1))
    story.append(Paragraph(
        "Analogous to Appendix B of PHREEQC-MCQ-200 (CoT vs Direct token usage), "
        "Table B1 reports total and median wall-clock seconds per question. Tool-augmented "
        "modes increase elapsed time but raise accuracy on every model family in this run.", body))
    elapsed = elapsed_by_mode(data)
    rows_b = [["Model", "Mode", "Total (s)", "Median (s)", "Mean (s)", "Accuracy"]]
    for model in MODELS:
        for mode in MODES:
            st = elapsed.get((model, mode))
            if not st:
                continue
            rows_b.append([
                MODEL_NAMES[model], MODE_NAMES[mode],
                f"{st['total_s']:.0f}", f"{st['median_s']:.1f}",
                f"{st['mean_s']:.1f}", f"{st['acc']:.1f}%",
            ])
    tb = Table(rows_b, colWidths=[3.4 * cm, 2.4 * cm, 2.2 * cm, 2.2 * cm, 2.2 * cm, 2.0 * cm],
               repeatRows=1)
    tb.setStyle(tstyle())
    story.append(tb)
    story.append(Paragraph("Table B1: Wall-clock cost and accuracy by model and mode.", caption))

    # ---- C: Cross-mode overlap ----
    story.append(PageBreak())
    story.append(Paragraph("C&nbsp;&nbsp;Cross-Mode Right-Item Overlap", h1))
    story.append(Paragraph(
        "Tables C1–C2 mirror Appendix C.5 of PHREEQC-MCQ-200, comparing which items "
        "each evaluation mode solves. C1 pairs no-tool vs agent; C2 gives the full three-way "
        "partition over no-tool, code generation, and agent.", body))
    rows_c1 = [["Model", "No-tool right", "Agent right", "Both", "NT only", "Agent only", "Neither"]]
    rows_c2 = [["Model", "All 3", "NT only", "CG only", "Ag only", "NT∩CG", "NT∩Ag", "CG∩Ag", "None"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        cg = data.get((model, "code_generation"))
        ag = data.get((model, "agent"))
        if nt and ag:
            ov = overlap_partition(nt, ag)
            rows_c1.append([
                MODEL_NAMES[model], str(ov["a_right"]), str(ov["b_right"]),
                str(ov["both"]), str(ov["a_only"]), str(ov["b_only"]), str(ov["neither"]),
            ])
        if nt and cg and ag:
            p = three_way_partition(nt, cg, ag)
            rows_c2.append([
                MODEL_NAMES[model],
                str(p.get("all_three", 0)), str(p.get("nt_only", 0)),
                str(p.get("cg_only", 0)), str(p.get("ag_only", 0)),
                str(p.get("nt_cg", 0)), str(p.get("nt_ag", 0)),
                str(p.get("cg_ag", 0)), str(p.get("none", 0)),
            ])
    tc1 = Table(rows_c1, colWidths=[3.2 * cm] + [2.0 * cm] * 6, repeatRows=1)
    tc1.setStyle(tstyle(fs=7.0))
    story.append(tc1)
    story.append(Paragraph("Table C1: No-tool vs agent right-item overlap (each row sums to 150).", caption))
    tc2 = Table(rows_c2, colWidths=[2.8 * cm] + [1.65 * cm] * 8, repeatRows=1)
    tc2.setStyle(tstyle(fs=6.8))
    story.append(tc2)
    story.append(Paragraph("Table C2: Three-way partition over no-tool, code gen, and agent.", caption))

    overlap_png = os.path.join(APPENDIX_FIG_DIR, "fig_mode_exclusive.png")
    if os.path.exists(overlap_png):
        story.append(Image(overlap_png, width=12.6 * cm, height=8.1 * cm))
        story.append(Paragraph(
            "Figure A1: Items solved by exactly one mode (no-tool, code gen, or agent).", caption))

    # ---- D: Gain/loss/retention ----
    story.append(Paragraph("D&nbsp;&nbsp;Gain/Loss/Retention Decomposition", h1))
    story.append(Paragraph(
        "Table D1 decomposes each model's agent-mode outcome relative to its no-tool baseline: "
        "items gained (wrong→correct), lost (correct→wrong), and the retention rate among "
        "direct-correct items.", body))
    rows_d = [["Model", "Direct right", "Gained", "Lost", "Retained", "Retention", "Agent acc", "Δ (pp)"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not (nt and ag):
            continue
        st = retention_stats(nt, ag)
        rows_d.append([
            MODEL_NAMES[model], str(st["direct_right"]), str(st["gained"]), str(st["lost"]),
            str(st["retained"]), f"{st['retention_rate']:.1f}%",
            f"{acc(ag):.1f}%", f"{acc(ag) - acc(nt):+.1f}",
        ])
    td = Table(rows_d, colWidths=[3.0 * cm, 2.0 * cm, 1.6 * cm, 1.6 * cm, 1.8 * cm,
                                  1.8 * cm, 1.8 * cm, 1.4 * cm], repeatRows=1)
    td.setStyle(tstyle(fs=7.2))
    story.append(td)
    story.append(Paragraph("Table D1: Agent vs no-tool gain/loss/retention decomposition.", caption))

    # ---- E: Per-category stratification ----
    story.append(PageBreak())
    story.append(Paragraph("E&nbsp;&nbsp;Per-Category Difficulty Stratification", h1))
    story.append(Paragraph(
        "Analogous to Appendix E (per-scenario stratification), Table E1 reports agent-mode "
        "accuracy per question category with cross-model min/max/mean/spread.", body))
    cats, grid = category_grid(data, "agent")
    rows_e = [["Category", "N"] + [MODEL_NAMES[m] for m in MODELS] + ["min", "max", "mean", "spread"]]
    cat_n: dict[str, int] = defaultdict(int)
    for r in any_recs:
        cat_n[r.get("category", "?")] += 1
    for cat in sorted(cats, key=lambda c: -cat_n[c]):
        row = [cat, str(cat_n[cat])]
        vals = []
        for model in MODELS:
            if model in grid:
                v = grid[model].get(cat, float("nan"))
                row.append(f"{v:.0f}%" if not np.isnan(v) else "—")
                if not np.isnan(v):
                    vals.append(v)
            else:
                row.append("—")
        if vals:
            row += [f"{min(vals):.0f}%", f"{max(vals):.0f}%",
                    f"{np.mean(vals):.0f}%", f"{max(vals)-min(vals):.0f}"]
        else:
            row += ["—"] * 4
        rows_e.append(row)
    te = Table(rows_e, colWidths=[3.6 * cm, 0.8 * cm] + [1.5 * cm] * len(MODELS) + [1.2 * cm] * 4,
               repeatRows=1)
    te.setStyle(tstyle(fs=6.2))
    story.append(te)
    story.append(Paragraph(
        "Table E1: Agent-mode accuracy (%) per category; spread = max − min across models (pp).",
        caption))

    spread_png = os.path.join(APPENDIX_FIG_DIR, "fig_category_spread.png")
    if os.path.exists(spread_png):
        ir = ImageReader(spread_png)
        iw, ih = ir.getSize()
        w = 13.0 * cm
        h = min(w * ih / iw, 18 * cm)
        if h < w * ih / iw:
            w = h * iw / ih
        story.append(Image(spread_png, width=w, height=h))
        story.append(Paragraph(
            "Figure A2: Cross-model spread in agent-mode accuracy by category.", caption))

    # ---- F: Retention decomposition axes ----
    story.append(Paragraph("F&nbsp;&nbsp;Retention Decomposition by Difficulty and Label", h1))
    story.append(Paragraph(
        "Tables F1–F2 mirror Appendix F: among no-tool-correct items, the fraction lost "
        "under agent mode, stratified by difficulty tier and true answer label.", body))
    rows_f1 = [["Model"] + DIFFS + ["Overall"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not (nt and ag):
            continue
        rates = lost_by_difficulty(nt, ag)
        rows_f1.append([MODEL_NAMES[model]] + [
            f"{rates[d]:.1f}%" if not np.isnan(rates[d]) else "—" for d in DIFFS + ["overall"]
        ])
    tf1 = Table(rows_f1, colWidths=[3.8 * cm] + [2.5 * cm] * 4, repeatRows=1)
    tf1.setStyle(tstyle())
    story.append(tf1)
    story.append(Paragraph(
        "Table F1: Lost-item rate (%) among no-tool-correct items when switching to agent mode.",
        caption))

    lost_png = os.path.join(APPENDIX_FIG_DIR, "fig_lost_rate_heatmap.png")
    if os.path.exists(lost_png):
        story.append(Image(lost_png, width=11.6 * cm, height=7.3 * cm))
        story.append(Paragraph("Figure A3: Lost-item rate heatmap by model and difficulty tier.", caption))

    rows_f2 = [["Model", "Lost A", "Lost B", "Lost C", "Lost D", "Total lost"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not (nt and ag):
            continue
        lb = lost_by_truth_label(nt, ag)
        total = sum(v[0] for v in lb.values())
        rows_f2.append([MODEL_NAMES[model]] + [str(lb[l][0]) for l in LABELS] + [str(total)])
    rows_f2.append(["Benchmark truth count"] + [str(truth.get(l, 0)) for l in LABELS] + [str(n_q)])
    tf2 = Table(rows_f2, colWidths=[3.8 * cm] + [2.0 * cm] * 5, repeatRows=1)
    tf2.setStyle(tstyle())
    story.append(tf2)
    story.append(Paragraph("Table F2: Lost-item counts by true answer label (no-tool→agent).", caption))

    # Top categories for lost items
    story.append(Paragraph("F.1&nbsp;&nbsp;Lost-Item Concentration by Category", h2))
    rows_f3 = [["Model", "Total lost", "Top contributing categories"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        ag = data.get((model, "agent"))
        if not (nt and ag):
            continue
        st = retention_stats(nt, ag)
        lbc = lost_by_category(nt, ag)
        top = sorted(lbc.items(), key=lambda kv: -kv[1][0])[:5]
        top_str = "; ".join(f"{c} ({n}/{t})" for c, (n, t, _) in top if n > 0) or "—"
        rows_f3.append([MODEL_NAMES[model], str(st["lost"]), top_str])
    tf3 = Table(rows_f3, colWidths=[3.2 * cm, 1.8 * cm, 10.5 * cm], repeatRows=1)
    tf3.setStyle(tstyle(fs=7.0))
    story.append(tf3)
    story.append(Paragraph("Table F3: Top categories contributing to lost items.", caption))

    # ---- G: Code generation failure breakdown ----
    story.append(PageBreak())
    story.append(Paragraph("G&nbsp;&nbsp;Code-Generation Failure Breakdown", h1))
    story.append(Paragraph(
        "Table G1 classifies incorrect code-generation trajectories into execution errors "
        "(nonzero exit code or missing code) vs wrong interpretation (code ran but answer wrong).",
        body))
    rows_g = [["Model", "Timeout", "Exec error", "Wrong interp.", "Total errors"]]
    for model in MODELS:
        recs = data.get((model, "code_generation"))
        if not recs:
            continue
        cats = auto_failure_counts(recs, "code_generation")
        rows_g.append([
            MODEL_NAMES[model],
            str(cats.get("timeout", 0)), str(cats.get("exec_error", 0)),
            str(cats.get("wrong_interp", 0)), str(sum(cats.values())),
        ])
    tg = Table(rows_g, colWidths=[4.0 * cm, 2.2 * cm, 2.2 * cm, 2.4 * cm, 2.2 * cm], repeatRows=1)
    tg.setStyle(tstyle())
    story.append(tg)
    story.append(Paragraph("Table G1: Code-generation error decomposition.", caption))

    # ---- H: Agent trajectory statistics ----
    story.append(Paragraph("H&nbsp;&nbsp;Agent Trajectory Statistics", h1))
    story.append(Paragraph(
        "Table H1 mirrors Appendix I (trajectory length): wall-clock seconds, tool-call counts, "
        "and failed-item tool-use for agent-mode runs.", body))
    rows_h = [["Model", "Wall med.", "Wall p90", "Tools med.", "Shell med.",
               "Failed n", "Fail tools med.", "Fail tools mean"]]
    for model in MODELS:
        recs = data.get((model, "agent"))
        if not recs:
            continue
        st = trajectory_stats(recs)
        rows_h.append([
            MODEL_NAMES[model],
            f"{st['wall_med']:.1f}", f"{st['wall_p90']:.1f}",
            f"{st['tools_med']:.0f}", f"{st['shell_med']:.0f}",
            str(st["failed_n"]), f"{st['failed_tools_med']:.0f}",
            f"{st['failed_tools_mean']:.1f}",
        ])
    th = Table(rows_h, colWidths=[3.2 * cm] + [1.85 * cm] * 7, repeatRows=1)
    th.setStyle(tstyle(fs=7.0))
    story.append(th)
    story.append(Paragraph("Table H1: Agent-mode trajectory statistics.", caption))

    # ---- I: Automatic agent failure taxonomy ----
    story.append(Paragraph("I&nbsp;&nbsp;Automatic Agent Failure Taxonomy", h1))
    rows_i = [["Model", "Timeout", "Exec error", "No tool use", "Wrong interp.", "Total errors"]]
    for model in MODELS:
        recs = data.get((model, "agent"))
        if not recs:
            continue
        cats = auto_failure_counts(recs, "agent")
        rows_i.append([
            MODEL_NAMES[model],
            str(cats.get("timeout", 0)), str(cats.get("exec_error", 0)),
            str(cats.get("no_tool_use", 0)), str(cats.get("wrong_interp", 0)),
            str(sum(cats.values())),
        ])
    ti = Table(rows_i, colWidths=[3.4 * cm, 2.0 * cm, 2.0 * cm, 2.2 * cm, 2.2 * cm, 2.0 * cm],
               repeatRows=1)
    ti.setStyle(tstyle())
    story.append(ti)
    story.append(Paragraph(
        "Table I1: Log-derived agent failure categories (Appendix I/J analogue). "
        "<i>No tool use</i>: agent answered from memory despite tool-first instruction.",
        caption))

    # ---- J: Per-label agent accuracy detail ----
    story.append(PageBreak())
    story.append(Paragraph("J&nbsp;&nbsp;Per-True-Label Agent Accuracy", h1))
    rows_j = [["Model", "Acc A", "Acc B", "Acc C", "Acc D", "Spread"]]
    for model in MODELS:
        recs = data.get((model, "agent"))
        if not recs:
            continue
        pl = per_label_accuracy(recs)
        vals = [pl.get(l, float("nan")) for l in LABELS]
        spread = max(vals) - min(vals) if vals else float("nan")
        rows_j.append([MODEL_NAMES[model]] + [
            f"{v:.1f}%" if not np.isnan(v) else "—" for v in vals
        ] + [f"{spread:.1f}"])
    tj = Table(rows_j, colWidths=[3.6 * cm] + [2.3 * cm] * 5, repeatRows=1)
    tj.setStyle(tstyle())
    story.append(tj)
    story.append(Paragraph("Table J1: Agent-mode accuracy by true answer label.", caption))

    # ---- L: No-tool → code-gen retention ----
    story.append(PageBreak())
    story.append(Paragraph("L&nbsp;&nbsp;No-Tool → Code-Generation Retention", h1))
    story.append(Paragraph(
        "Table L1 mirrors Table D1 but compares no-tool to single-shot code generation. "
        "Most gains occur at this step; agent mode adds smaller incremental improvements.",
        body))
    rows_l = [["Model", "Direct right", "Gained", "Lost", "Retained", "Retention",
               "CG acc", "Δ (pp)"]]
    for model in MODELS:
        nt = data.get((model, "no_tool"))
        cg = data.get((model, "code_generation"))
        if not (nt and cg):
            continue
        st = retention_stats(nt, cg)
        rows_l.append([
            MODEL_NAMES[model], str(st["direct_right"]), str(st["gained"]), str(st["lost"]),
            str(st["retained"]), f"{st['retention_rate']:.1f}%",
            f"{acc(cg):.1f}%", f"{acc(cg) - acc(nt):+.1f}",
        ])
    tl = Table(rows_l, colWidths=[3.0 * cm, 1.9 * cm, 1.5 * cm, 1.5 * cm, 1.7 * cm,
                                   1.7 * cm, 1.7 * cm, 1.4 * cm], repeatRows=1)
    tl.setStyle(tstyle(fs=7.2))
    story.append(tl)
    story.append(Paragraph("Table L1: Code generation vs no-tool gain/loss/retention.", caption))

    # ---- M: Code-gen vs agent overlap ----
    story.append(Paragraph("M&nbsp;&nbsp;Code-Generation vs Agent Overlap", h1))
    rows_m = [["Model", "CG right", "Agent right", "Both", "CG only", "Agent only", "Neither"]]
    for model in MODELS:
        cg = data.get((model, "code_generation"))
        ag = data.get((model, "agent"))
        if not (cg and ag):
            continue
        ov = overlap_partition(cg, ag)
        rows_m.append([
            MODEL_NAMES[model], str(ov["a_right"]), str(ov["b_right"]),
            str(ov["both"]), str(ov["a_only"]), str(ov["b_only"]), str(ov["neither"]),
        ])
    tm = Table(rows_m, colWidths=[3.2 * cm] + [2.0 * cm] * 6, repeatRows=1)
    tm.setStyle(tstyle(fs=7.0))
    story.append(tm)
    story.append(Paragraph(
        "Table M1: Items solved under code generation vs agent (each row sums to 150).",
        caption))

    # ---- N: Cost efficiency ----
    story.append(Paragraph("N&nbsp;&nbsp;Cost Efficiency (Seconds per Correct)", h1))
    elapsed = elapsed_by_mode(data)
    rows_n = [["Model", "No tool", "Code gen", "Agent"]]
    for model in MODELS:
        row = [MODEL_NAMES[model]]
        for mode in MODES:
            st = elapsed.get((model, mode))
            if st and st["n_corr"]:
                row.append(f"{st['sec_per_correct']:.1f}s")
            else:
                row.append("—")
        rows_n.append(row)
    tn = Table(rows_n, colWidths=[3.6 * cm, 3.5 * cm, 3.5 * cm, 3.5 * cm], repeatRows=1)
    tn.setStyle(tstyle())
    story.append(tn)
    story.append(Paragraph("Table N1: Wall-clock seconds per correct answer.", caption))
    eff_png = os.path.join(APPENDIX_FIG_DIR, "fig_efficiency.png")
    if os.path.exists(eff_png):
        story.append(Image(eff_png, width=12.6 * cm, height=7.9 * cm))
        story.append(Paragraph("Figure A4: Seconds per correct answer by model and mode.", caption))

    # ---- O: Per-difficulty by mode ----
    story.append(Paragraph("O&nbsp;&nbsp;Per-Difficulty Accuracy by Mode", h1))
    story.append(Paragraph(
        "Table O1 reports mean accuracy across models for each difficulty tier and "
        "evaluation mode.", body))
    to = Table(per_difficulty_mode_table(data),
               colWidths=[2.5 * cm, 3.5 * cm, 3.5 * cm, 3.5 * cm], repeatRows=1)
    to.setStyle(tstyle())
    story.append(to)
    story.append(Paragraph(
        "Table O1: Mean cross-model accuracy (%) by difficulty tier and mode.", caption))
    hm_png = os.path.join(APPENDIX_FIG_DIR, "fig_agent_heatmap.png")
    if os.path.exists(hm_png):
        story.append(Image(hm_png, width=11.0 * cm, height=7.9 * cm))
        story.append(Paragraph(
            "Figure A5: Agent-mode accuracy heatmap (model × difficulty tier).", caption))

    # ---- P: Cross-model agreement & hardest items ----
    story.append(PageBreak())
    story.append(Paragraph("P&nbsp;&nbsp;Cross-Model Agreement and Hardest Items", h1))
    agree = cross_model_agent_agreement(data)
    story.append(Paragraph(
        f"In agent mode, {agree['all_right']} of {n_q} items are answered correctly by "
        f"all {len(MODELS)} models; {agree['all_wrong']} are missed by every model; "
        f"{agree['mixed']} show mixed outcomes across models.", body))
    fails = agent_failures_by_question(data)
    rows_p = [["QID", "Difficulty", "Category", "Failed", "Expected"]]
    for qid, info in sorted(fails.items(), key=lambda kv: (-kv[1]["count"], kv[0]))[:20]:
        m = info["meta"]
        rows_p.append([
            str(qid), m.get("difficulty", "?"), m.get("category", "?"),
            f"{info['count']}/{len(MODELS)}", m.get("expected", "?"),
        ])
    if len(rows_p) > 1:
        tp = Table(rows_p, colWidths=[1.4 * cm, 2.0 * cm, 5.0 * cm, 1.8 * cm, 1.6 * cm],
                   repeatRows=1)
        tp.setStyle(tstyle(fs=7.5))
        story.append(tp)
        story.append(Paragraph(
            "Table P1: Questions with at least one agent-mode failure (top 20 by failure count).",
            caption))
    hard_png = os.path.join(APPENDIX_FIG_DIR, "fig_hard_questions.png")
    if os.path.exists(hard_png):
        ir = ImageReader(hard_png)
        iw, ih = ir.getSize()
        w = 12.0 * cm
        h = min(w * ih / iw, 16 * cm)
        if h < w * ih / iw:
            w = h * iw / ih
        story.append(Image(hard_png, width=w, height=h))
        story.append(Paragraph("Figure A6: Cross-model agent failure counts.", caption))

    # ---- Q: Code-generation script statistics ----
    story.append(Paragraph("Q&nbsp;&nbsp;Code-Generation Script Statistics", h1))
    rows_q = [["Model", "Mean chars", "Median chars", "Exec OK", "Exec rate", "CG acc"]]
    for model in MODELS:
        recs = data.get((model, "code_generation"))
        if not recs:
            continue
        st = code_gen_stats(recs)
        rows_q.append([
            MODEL_NAMES[model],
            f"{st['mean_chars']:.0f}", f"{st['median_chars']:.0f}",
            f"{st['exec_ok']}/{st['n']}",
            f"{100.0 * st['exec_ok'] / st['n']:.1f}%",
            f"{acc(recs):.1f}%",
        ])
    tq = Table(rows_q, colWidths=[3.4 * cm, 2.2 * cm, 2.2 * cm, 2.0 * cm, 2.0 * cm, 2.0 * cm],
               repeatRows=1)
    tq.setStyle(tstyle())
    story.append(tq)
    story.append(Paragraph("Table Q1: Generated script size and execution success.", caption))
    cg_png = os.path.join(APPENDIX_FIG_DIR, "fig_codegen_exec.png")
    if os.path.exists(cg_png):
        story.append(Image(cg_png, width=10.8 * cm, height=6.8 * cm))
        story.append(Paragraph("Figure A7: Code-generation execution success rate.", caption))

    # ---- R: No-tool confusion (aggregate) ----
    story.append(Paragraph("R&nbsp;&nbsp;No-Tool Confusion Patterns", h1))
    story.append(Paragraph(
        "Table R1 aggregates no-tool predictions vs true labels across all models "
        "(pooled over 5 × 150 = 750 responses). Off-diagonal mass indicates "
        "systematic mis-estimation rather than random guessing.", body))
    pooled = Counter()
    for model in MODELS:
        recs = data.get((model, "no_tool"))
        if recs:
            for k, v in no_tool_confusion_matrix(recs).items():
                pooled[k] += v
    rows_r = [["Truth \\ Pred"] + LABELS]
    for truth_lab in LABELS:
        rows_r.append([truth_lab] + [str(pooled.get((truth_lab, pred), 0)) for pred in LABELS])
    tr = Table(rows_r, colWidths=[2.2 * cm] + [2.5 * cm] * 4, repeatRows=1)
    tr.setStyle(tstyle())
    story.append(tr)
    story.append(Paragraph("Table R1: Pooled no-tool confusion matrix (counts).", caption))

    # ---- S: Category-level mode deltas ----
    story.append(PageBreak())
    story.append(Paragraph("S&nbsp;&nbsp;Category-Level Mode Deltas", h1))
    story.append(Paragraph(
        "Table S1 reports mean per-category accuracy change (in percentage points) "
        "relative to no-tool, averaged over models.", body))
    deltas = category_mode_deltas(data)
    rows_s = [["Category", "Δ code gen", "Δ agent"]]
    for cat, d_cg, d_ag in deltas[:25]:
        rows_s.append([
            cat,
            f"{d_cg:+.1f}" if not np.isnan(d_cg) else "—",
            f"{d_ag:+.1f}" if not np.isnan(d_ag) else "—",
        ])
    ts = Table(rows_s, colWidths=[6.5 * cm, 2.5 * cm, 2.5 * cm], repeatRows=1)
    ts.setStyle(tstyle(fs=7.0))
    story.append(ts)
    story.append(Paragraph(
        "Table S1: Mean category-level Δ accuracy (pp) vs no-tool (top 25 categories).",
        caption))

    # ---- T: Agent error inventory ----
    story.append(Paragraph("T&nbsp;&nbsp;Complete Agent-Mode Error Inventory", h1))
    errors = agent_error_details(data)
    rows_t = [["Model", "QID", "Diff", "Category", "Exp", "Ans", "Failure", "Tools", "Time"]]
    for e in errors:
        rows_t.append([
            MODEL_NAMES[e["model"]], str(e["qid"]), e["difficulty"] or "?",
            (e["category"] or "?")[:22], e["expected"] or "?", e["answer"] or "?",
            e["failure"] or "?", str(e["tool_calls"]), f"{e['elapsed_s']:.0f}s",
        ])
    if len(rows_t) > 1:
        tt = Table(rows_t, colWidths=[2.6 * cm, 1.0 * cm, 1.3 * cm, 3.2 * cm,
                                       0.9 * cm, 0.9 * cm, 1.8 * cm, 1.0 * cm, 1.2 * cm],
                   repeatRows=1)
        tt.setStyle(tstyle(fs=6.5))
        story.append(tt)
        story.append(Paragraph(
            f"Table T1: All {len(errors)} agent-mode errors across models.", caption))
    else:
        story.append(Paragraph("No agent-mode errors recorded.", body))

    # ---- U: No-tool per-label accuracy (all models) ----
    story.append(Paragraph("U&nbsp;&nbsp;No-Tool Per-Label Accuracy", h1))
    rows_u = [["Model", "Acc A", "Acc B", "Acc C", "Acc D", "Spread", "Overall"]]
    for model in MODELS:
        recs = data.get((model, "no_tool"))
        if not recs:
            continue
        pl = per_label_accuracy(recs)
        vals = [pl.get(l, float("nan")) for l in LABELS]
        spread = max(vals) - min(vals) if vals else float("nan")
        rows_u.append([MODEL_NAMES[model]] + [
            f"{v:.1f}%" if not np.isnan(v) else "—" for v in vals
        ] + [f"{spread:.1f}", f"{acc(recs):.1f}%"])
    tu = Table(rows_u, colWidths=[3.2 * cm] + [1.9 * cm] * 5 + [2.0 * cm], repeatRows=1)
    tu.setStyle(tstyle(fs=7.2))
    story.append(tu)
    story.append(Paragraph(
        "Table U1: No-tool accuracy by true answer label; spread = max − min (pp).",
        caption))

    # ---- K: Datasheet ----
    story.append(Paragraph("K&nbsp;&nbsp;Datasheet for VeraGridAgent MCQ Benchmark", h1))
    with open(QUESTIONS_FILE, encoding="utf-8") as f:
        qbank = json.load(f)
    questions = qbank.get("questions", qbank if isinstance(qbank, list) else [])
    n_cats = len({q.get("category") for q in questions})
    story.append(Paragraph(
        f"<b>Instances.</b> {n_q} four-option MCQ items on the AC-OPF solution of an "
        f"{n_bus}-bus / {n_gen}-generator / {n_line}-line test system. Items span {n_cats} "
        f"categories stratified into three difficulty tiers (50 Easy, 50 Medium, 50 Hard). "
        f"Truth labels: A={truth.get('A',0)}, B={truth.get('B',0)}, C={truth.get('C',0)}, "
        f"D={truth.get('D',0)} (majority-label baseline {100*max(truth.values())/n_q:.1f}%).",
        body))
    story.append(Paragraph(
        "<b>Ground truth.</b> Every answer is fixed by the VeraGridEngine reference AC-OPF "
        "solver and verified before evaluation. Distractors are multiplicative perturbations of "
        "the correct numeric value.", body))
    story.append(Paragraph(
        "<b>Evaluation modes.</b> (i) No-tool chain-of-thought with full circuit context; "
        "(ii) single-shot Python code executed once in the reference environment; "
        "(iii) tool-augmented agent loop with shell/file access to run_opf.py and "
        "opf_results.json. Timeouts: 300 s (no-tool), 780 s total (code gen), 480 s (agent).",
        body))
    story.append(Paragraph(
        "<b>Models evaluated.</b> " + ", ".join(MODEL_NAMES[m] for m in MODELS) + ". "
        "All accessed via the cursor-agent CLI harness.", body))
    story.append(Paragraph(
        "<b>Companion artifacts.</b> Per-question JSONL logs in benchmark_results/raw/; "
        "analysis scripts benchmark_report.py and benchmark_appendix_report.py regenerate "
        "the main report and this appendix.", body))

    doc = SimpleDocTemplate(
        PDF_PATH, pagesize=A4,
        leftMargin=1.8 * cm, rightMargin=1.8 * cm,
        topMargin=1.5 * cm, bottomMargin=1.5 * cm,
        title="VeraGridAgent Benchmark Appendix",
        author="Shivanshu Tripathi",
    )
    doc.build(story)


def main() -> int:
    os.makedirs(APPENDIX_FIG_DIR, exist_ok=True)
    data = load_records()
    if not data:
        print("No result files found in", RAW_DIR)
        return 1
    fig_retention_heatmap(data)
    fig_category_spread(data)
    fig_overlap_bars(data)
    fig_efficiency(data)
    fig_hard_questions(data)
    fig_codegen_exec(data)
    fig_agent_heatmap(data)
    build_pdf(data)
    print(f"[DONE] Appendix PDF: {PDF_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
