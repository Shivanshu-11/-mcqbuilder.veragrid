#!/usr/bin/env python3
"""
VeraGrid MCQ Benchmark Runner
=============================
Runs the paper-style three-rung interface-complexity ladder over the
VeraGrid AC-OPF MCQ set, using the cursor-agent CLI as the model backend:

  no_tool          : ask-mode, strict no-tool directive. Parametric reasoning only.
  code_generation  : model writes ONE Python script; we execute it once in the
                     reference environment (numpy/scipy/VeraGridEngine); the model
                     sees the output and picks the closest option. No iteration.
  agent            : full cursor agent loop with shell/file tools in a workspace
                     seeded with the circuit model and a run_opf.py reference
                     solver wrapper.

Results are checkpointed per question to JSONL files, so re-running resumes
where it left off.

Usage:
  python benchmark_runner.py --models gpt-5.2 claude-4.5-sonnet --modes no_tool agent
  python benchmark_runner.py --limit 5   # smoke test
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)

from evaluator import extract_letter, load_questions, EvalQuestion  # noqa: E402
from agent import _find_cursor_agent_binary, _strip_cursor_prefix  # noqa: E402


def build_benchmark_circuit_context(fc: dict[str, Any]) -> str:
    """Complete circuit description straight from the frontend model, keeping
    element names (the questions reference 'Gen 3', 'Load D', 'Line 2-3', ...)
    and the generator cost model used by the reference AC-OPF."""
    lines = ["--- CIRCUIT MODEL (ground truth input to the AC-OPF) ---",
             "System base: 100 MVA. Nominal voltage: 20 kV.",
             "",
             "Generators (cost(P) = a*P_pu^2 + b*P_pu, with P_pu = P_MW/100):"]
    for g in fc.get("GENERATORS", []):
        lines.append(
            f"  {g['name']}: bus {g['bus']}, Pmin={g['Pmin']} MW, Pmax={g['Pmax']} MW, "
            f"a={g['a']}, b={g['b']}, Vset={g.get('vset', 1.0)} pu"
        )
    lines.append("")
    lines.append("Loads:")
    for ld in fc.get("LOADS", []):
        lines.append(f"  {ld['name']}: bus {ld['bus']}, P={ld['P']} MW, Q={ld['Q']} MVAr")
    lines.append("")
    lines.append("Lines (r, x, b in pu on 100 MVA base):")
    for ln in fc.get("LINES", []):
        lines.append(
            f"  {ln['name']}: bus {ln['from']} -> bus {ln['to']}, "
            f"r={ln['r']}, x={ln['x']}, b={ln['b']}"
        )
    lines.append("")
    lines.append("The generator named 'Slack' is the slack/reference bus. "
                 "Questions refer to the solved AC optimal power flow (AC-OPF) of "
                 "this circuit: optimal dispatch, bus voltages, branch flows, "
                 "losses and costs.")
    lines.append("--- END CIRCUIT MODEL ---")
    return "\n".join(lines)

QUESTIONS_FILE = os.path.join(BACKEND_DIR, "mcq_questions.web.json")
CIRCUIT_FILE = os.path.join(BACKEND_DIR, "eval_circuit.web.json")
WEB_OPF_SCRIPT = os.path.join(BACKEND_DIR, "web_opf_agent.py")
VENV_PYTHON = "/Users/shivanshutripathi/PSCAD/.venv312/bin/python"
OUT_DIR = os.path.join(BACKEND_DIR, "benchmark_results")

DEFAULT_MODELS = ["gpt-5.2", "claude-4.5-sonnet", "gemini-3-flash", "grok-4.3"]
MODES = ["no_tool", "code_generation", "agent"]

# Path to the Claude Code CLI (bundled with the IDE extension). Used when
# --backend claude-code is selected, so a Claude subscription can drive models
# (e.g. Fable 5) that are unavailable / rate-limited through cursor-agent.
CLAUDE_BIN = os.environ.get(
    "CLAUDE_BIN",
    "/Users/shivanshutripathi/.cursor/extensions/"
    "anthropic.claude-code-2.1.193-darwin-arm64/resources/native-binary/claude",
)
CLAUDE_ASK_DISALLOWED = [
    "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch",
    "NotebookEdit", "Task", "TodoWrite", "BashOutput", "KillShell",
    "SlashCommand", "ExitPlanMode",
]

# Selected at startup from --backend; module-level so the mode runners can
# dispatch without threading it through every call.
_BACKEND = "cursor"

NO_TOOL_TIMEOUT = float(os.environ.get("NO_TOOL_TIMEOUT", "300"))
CODEGEN_TIMEOUT = 360.0
CODEGEN_EXEC_TIMEOUT = 240.0
CODEGEN_PICK_TIMEOUT = 180.0
AGENT_TIMEOUT = 480.0

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# cursor-agent CLI wrapper (own prompts, no baked-in system prompt)
# ---------------------------------------------------------------------------

def cursor_call(
    model: str,
    prompt: str,
    workspace: str,
    ask_mode: bool,
    timeout: float,
) -> dict[str, Any]:
    """Single cursor-agent CLI invocation. Returns {text, tool_calls, shell_runs,
    errors, elapsed_s, timed_out}."""
    binary = _find_cursor_agent_binary()
    if not binary:
        raise RuntimeError("cursor-agent CLI not found")

    args = [
        binary,
        "--print",
        "--output-format", "stream-json",
        "--workspace", workspace,
        "--model", _strip_cursor_prefix(model),
        "--trust",
    ]
    if ask_mode:
        args.extend(["--mode", "ask"])
    else:
        args.append("--force")
    args.append(prompt)

    out: dict[str, Any] = {
        "text": "",
        "tool_calls": 0,
        "shell_runs": 0,
        "wrote_files": False,
        "read_files": False,
        "errors": [],
        "elapsed_s": 0.0,
        "timed_out": False,
    }
    t0 = time.time()
    try:
        proc = subprocess.run(
            args, cwd=workspace, capture_output=True, text=True,
            timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        out["timed_out"] = True
        out["errors"].append(f"timeout after {timeout:.0f}s")
        out["elapsed_s"] = round(time.time() - t0, 1)
        return out
    out["elapsed_s"] = round(time.time() - t0, 1)

    final_text = ""
    last_assistant = ""
    for raw_line in (proc.stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "assistant":
            try:
                for piece in event["message"]["content"]:
                    if isinstance(piece, dict) and piece.get("type") == "text":
                        last_assistant = piece.get("text", "") or last_assistant
            except Exception:
                pass
        elif etype == "tool_call" and event.get("subtype") == "completed":
            out["tool_calls"] += 1
            tool_obj = event.get("tool_call") or {}
            for key in tool_obj:
                k = key.lower()
                if "shell" in k or "terminal" in k or "run" in k:
                    out["shell_runs"] += 1
                elif "write" in k or "edit" in k:
                    out["wrote_files"] = True
                elif "read" in k:
                    out["read_files"] = True
        elif etype == "result":
            final_text = event.get("result") or final_text

    if not final_text:
        final_text = last_assistant
    if proc.returncode != 0 and not final_text:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        out["errors"].append("cursor-agent rc=%s %s" % (proc.returncode, " | ".join(tail)))
    out["text"] = (final_text or "").strip()
    return out


# ---------------------------------------------------------------------------
# Claude Code CLI wrapper (drives a Claude subscription, e.g. Fable 5)
# ---------------------------------------------------------------------------

def claude_code_call(
    model: str,
    prompt: str,
    workspace: str,
    ask_mode: bool,
    timeout: float,
) -> dict[str, Any]:
    """Single `claude -p` invocation. Same return contract as cursor_call.

    ask_mode=True  -> all tools disallowed (pure knowledge / code-writing).
    ask_mode=False -> tools enabled, permissions auto-approved (agent loop).
    """
    if not os.path.exists(CLAUDE_BIN):
        raise RuntimeError(f"claude CLI not found at {CLAUDE_BIN}")

    # Prompt goes via stdin: a variadic flag like --disallowedTools would
    # otherwise swallow a positional prompt argument as extra tool names.
    args = [CLAUDE_BIN, "-p", "--model", model,
            "--output-format", "stream-json", "--verbose"]
    if not ask_mode:
        args += ["--permission-mode", "bypassPermissions", "--add-dir", workspace]
    if ask_mode:
        args += ["--disallowedTools", *CLAUDE_ASK_DISALLOWED]

    out: dict[str, Any] = {
        "text": "", "tool_calls": 0, "shell_runs": 0, "wrote_files": False,
        "read_files": False, "errors": [], "elapsed_s": 0.0, "timed_out": False,
    }
    t0 = time.time()
    try:
        proc = subprocess.run(args, cwd=workspace, capture_output=True, text=True,
                              input=prompt, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        out["timed_out"] = True
        out["errors"].append(f"timeout after {timeout:.0f}s")
        out["elapsed_s"] = round(time.time() - t0, 1)
        return out
    out["elapsed_s"] = round(time.time() - t0, 1)

    final_text = ""
    last_assistant = ""
    for raw_line in (proc.stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "assistant":
            for piece in (event.get("message", {}) or {}).get("content", []) or []:
                if not isinstance(piece, dict):
                    continue
                if piece.get("type") == "text":
                    last_assistant = piece.get("text", "") or last_assistant
                elif piece.get("type") == "tool_use":
                    out["tool_calls"] += 1
                    name = (piece.get("name") or "").lower()
                    if "bash" in name:
                        out["shell_runs"] += 1
                    elif name in ("write", "edit", "notebookedit"):
                        out["wrote_files"] = True
                    elif name in ("read", "glob", "grep"):
                        out["read_files"] = True
        elif etype == "result":
            final_text = event.get("result") or final_text
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                msg = (event.get("result") or event.get("subtype") or "error")
                out["errors"].append(f"claude {event.get('subtype')}: {str(msg)[:160]}")

    if not final_text:
        final_text = last_assistant
    if proc.returncode != 0 and not final_text:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        out["errors"].append("claude rc=%s %s" % (proc.returncode, " | ".join(tail)))
    out["text"] = (final_text or "").strip()
    return out


def backend_call(model: str, prompt: str, workspace: str, ask_mode: bool,
                 timeout: float) -> dict[str, Any]:
    """Dispatch to the configured model backend."""
    if _BACKEND == "claude-code":
        return claude_code_call(model, prompt, workspace, ask_mode, timeout)
    return cursor_call(model, prompt, workspace, ask_mode, timeout)


# ---------------------------------------------------------------------------
# Workspace seeding
# ---------------------------------------------------------------------------

RUN_OPF_WRAPPER = f'''#!/usr/bin/env python3
"""Reference AC-OPF runner: reads active_circuit_model.json, writes opf_results.json."""
import subprocess, sys
cmd = [
    {VENV_PYTHON!r},
    {WEB_OPF_SCRIPT!r},
    "--json-file", "active_circuit_model.json",
    "--results-output", "opf_results.json",
    "--vnom", "20",
]
proc = subprocess.run(cmd, capture_output=True, text=True)
sys.stdout.write(proc.stdout[-4000:])
sys.stderr.write(proc.stderr[-2000:])
sys.exit(proc.returncode)
'''


def seed_workspace(workspace: str, frontend_circuit: dict[str, Any]) -> None:
    with open(os.path.join(workspace, "active_circuit_model.json"), "w", encoding="utf-8") as f:
        json.dump(frontend_circuit, f, indent=2)
    with open(os.path.join(workspace, "run_opf.py"), "w", encoding="utf-8") as f:
        f.write(RUN_OPF_WRAPPER)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def question_block(q: EvalQuestion) -> str:
    options_text = "\n".join(f"{l}. {v}" for l, v in q.options)
    return f"Q{q.question_id}. {q.question}\n{options_text}"


def no_tool_prompt(circuit_context: str, q: EvalQuestion) -> str:
    return (
        "You are a power systems engineer answering a multiple-choice question "
        "about the AC optimal power flow (AC-OPF) solution of the circuit below.\n\n"
        f"{circuit_context}\n\n"
        "STRICT NO-TOOL MODE: answer using ONLY your own knowledge and reasoning. "
        "Do NOT call any tools. Do NOT read or write any files. Do NOT search the "
        "codebase. Do NOT execute any shell commands.\n\n"
        f"{question_block(q)}\n\n"
        "Reply with ONLY the option letter (A, B, C, or D)."
    )


def codegen_write_prompt(circuit_context: str, q: EvalQuestion) -> str:
    return (
        "You are a power systems engineer. Solve the following multiple-choice "
        "question about the AC-OPF solution of the circuit below by writing a "
        "SINGLE self-contained Python script.\n\n"
        f"{circuit_context}\n\n"
        f"{question_block(q)}\n\n"
        "Execution environment for your script:\n"
        "- Python 3.12 with numpy, scipy and VeraGridEngine installed.\n"
        "- The circuit model JSON (keys GENERATORS, LOADS, LINES) is in the current "
        "directory as 'active_circuit_model.json'.\n"
        "- A helper 'run_opf.py' is in the current directory: running it "
        "(e.g. subprocess.run(['python3','run_opf.py'])) executes the reference "
        "AC-OPF and writes full results to 'opf_results.json' (buses, branches, "
        "generators, loads, summary).\n\n"
        "Rules:\n"
        "- You get EXACTLY ONE execution. No iteration, no fixing afterwards.\n"
        "- The script MUST print the final numeric result (the quantity asked) "
        "on the last line.\n"
        "- Output ONLY the Python code inside one ```python code block. "
        "No other commentary."
    )


def codegen_pick_prompt(q: EvalQuestion, code: str, exec_out: str, exec_err: str, rc: int) -> str:
    status = "successfully" if rc == 0 else f"with an ERROR (exit code {rc})"
    return (
        "You previously wrote a Python script to answer this multiple-choice "
        "question. The script was executed " + status + ".\n\n"
        f"{question_block(q)}\n\n"
        "--- SCRIPT OUTPUT (stdout, tail) ---\n"
        f"{exec_out[-3000:] or '(empty)'}\n"
        "--- STDERR (tail) ---\n"
        f"{exec_err[-1500:] or '(empty)'}\n\n"
        "Based on this output (or your best judgment if the run failed), pick the "
        "closest matching option. Reply with ONLY the option letter (A, B, C, or D)."
    )


def agent_prompt(circuit_context: str, q: EvalQuestion) -> str:
    return (
        "You are a power systems engineer agent answering a multiple-choice "
        "question about the AC-OPF solution of the circuit below.\n\n"
        f"{circuit_context}\n\n"
        f"{question_block(q)}\n\n"
        "ENVIRONMENT: you are a CLI agent with shell and file tools inside this "
        "workspace. For ANY numerical question you MUST compute the answer with "
        "tools — do NOT answer from memory.\n"
        "- The circuit model is in 'active_circuit_model.json'.\n"
        "- Run the reference AC-OPF with the shell command: python3 run_opf.py\n"
        "  It writes complete results to 'opf_results.json' (buses, branches, "
        "generators, loads, summary) and prints result tables to stdout.\n"
        "- Read 'opf_results.json' (or the stdout tables) to extract the value "
        "asked, compute any derived quantity, and compare against the options.\n"
        "- If a command fails, inspect the error, fix it and retry.\n\n"
        "When you are confident, reply with ONLY the option letter (A, B, C, or D)."
    )


FINAL_LETTER_RE = re.compile(r"\b([A-D])\b")


def extract_final_letter(text: str) -> str:
    """Last standalone uppercase A-D in the reply. The final answer comes last;
    matching case-sensitively avoids the article 'a' and narration text."""
    matches = FINAL_LETTER_RE.findall(text or "")
    if matches:
        return matches[-1]
    return extract_letter(text)


CODE_BLOCK_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL)


def extract_code(text: str) -> str:
    blocks = CODE_BLOCK_RE.findall(text or "")
    if blocks:
        return max(blocks, key=len).strip()
    # Fall back: whole message if it looks like code
    if "print(" in (text or "") or "import " in (text or ""):
        return text.strip()
    return ""


# ---------------------------------------------------------------------------
# Per-question runners
# ---------------------------------------------------------------------------

def run_no_tool(model: str, q: EvalQuestion, circuit_context: str,
                frontend_circuit: dict[str, Any], workdir_base: str) -> dict[str, Any]:
    ws = tempfile.mkdtemp(prefix=f"nt_q{q.question_id}_", dir=workdir_base)
    try:
        res = backend_call(model, no_tool_prompt(circuit_context, q), ws,
                          ask_mode=True, timeout=NO_TOOL_TIMEOUT)
    finally:
        shutil.rmtree(ws, ignore_errors=True)
    letter = extract_final_letter(res["text"]) if not res["timed_out"] else "?"
    return {
        "answer": letter,
        "raw": res["text"][:400],
        "tool_calls": res["tool_calls"],
        "timed_out": res["timed_out"],
        "errors": res["errors"],
        "elapsed_s": res["elapsed_s"],
    }


def run_code_generation(model: str, q: EvalQuestion, circuit_context: str,
                        frontend_circuit: dict[str, Any], workdir_base: str) -> dict[str, Any]:
    ws = tempfile.mkdtemp(prefix=f"cg_q{q.question_id}_", dir=workdir_base)
    rec: dict[str, Any] = {"answer": "?", "raw": "", "tool_calls": 0, "timed_out": False,
                           "errors": [], "elapsed_s": 0.0, "exec_rc": None,
                           "code_chars": 0, "exec_stdout_tail": "", "exec_stderr_tail": ""}
    try:
        seed_workspace(ws, frontend_circuit)
        # 1) model writes the script (ask mode: no tool use)
        r1 = backend_call(model, codegen_write_prompt(circuit_context, q), ws,
                         ask_mode=True, timeout=CODEGEN_TIMEOUT)
        rec["elapsed_s"] += r1["elapsed_s"]
        rec["errors"].extend(r1["errors"])
        if r1["timed_out"]:
            rec["timed_out"] = True
            return rec
        code = extract_code(r1["text"])
        rec["code_chars"] = len(code)
        if not code:
            rec["errors"].append("no code block produced")
            rec["raw"] = r1["text"][:400]
            # Let it still answer from what it wrote
            letter = extract_final_letter(r1["text"])
            rec["answer"] = letter
            return rec
        script_path = os.path.join(ws, "solution.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)
        # 2) single execution in the reference environment
        try:
            proc = subprocess.run(
                [VENV_PYTHON, "solution.py"], cwd=ws, capture_output=True,
                text=True, timeout=CODEGEN_EXEC_TIMEOUT,
            )
            rc, out_s, err_s = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired:
            rc, out_s, err_s = -9, "", f"execution timed out after {CODEGEN_EXEC_TIMEOUT:.0f}s"
        rec["exec_rc"] = rc
        rec["exec_stdout_tail"] = (out_s or "")[-1500:]
        rec["exec_stderr_tail"] = (err_s or "")[-800:]
        # 3) model observes output, picks option
        r2 = backend_call(model, codegen_pick_prompt(q, code, out_s or "", err_s or "", rc),
                         ws, ask_mode=True, timeout=CODEGEN_PICK_TIMEOUT)
        rec["elapsed_s"] += r2["elapsed_s"]
        rec["errors"].extend(r2["errors"])
        if r2["timed_out"]:
            rec["timed_out"] = True
            return rec
        rec["raw"] = r2["text"][:400]
        rec["answer"] = extract_final_letter(r2["text"])
        return rec
    finally:
        shutil.rmtree(ws, ignore_errors=True)


def run_agent(model: str, q: EvalQuestion, circuit_context: str,
              frontend_circuit: dict[str, Any], workdir_base: str) -> dict[str, Any]:
    ws = tempfile.mkdtemp(prefix=f"ag_q{q.question_id}_", dir=workdir_base)
    try:
        seed_workspace(ws, frontend_circuit)
        res = backend_call(model, agent_prompt(circuit_context, q), ws,
                          ask_mode=False, timeout=AGENT_TIMEOUT)
    finally:
        shutil.rmtree(ws, ignore_errors=True)
    letter = extract_final_letter(res["text"]) if not res["timed_out"] else "?"
    return {
        "answer": letter,
        "raw": res["text"][:400],
        "tool_calls": res["tool_calls"],
        "shell_runs": res["shell_runs"],
        "wrote_files": res["wrote_files"],
        "read_files": res["read_files"],
        "timed_out": res["timed_out"],
        "errors": res["errors"],
        "elapsed_s": res["elapsed_s"],
    }


MODE_RUNNERS = {
    "no_tool": run_no_tool,
    "code_generation": run_code_generation,
    "agent": run_agent,
}


# ---------------------------------------------------------------------------
# Sweep orchestration with JSONL checkpointing
# ---------------------------------------------------------------------------

def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9.]+", "-", s).strip("-")


def jsonl_path(model: str, mode: str) -> str:
    return os.path.join(OUT_DIR, "raw", f"{slug(model)}__{mode}.jsonl")


def load_done(path: str) -> dict[int, dict[str, Any]]:
    done: dict[int, dict[str, Any]] = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    done[int(rec["question_id"])] = rec
                except Exception:
                    continue
    return done


def run_sweep(model: str, mode: str, questions: list[EvalQuestion],
              circuit_context: str, frontend_circuit: dict[str, Any],
              workers: int, workdir_base: str) -> None:
    path = jsonl_path(model, mode)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    done = load_done(path)
    todo = [q for q in questions if q.question_id not in done]
    if not todo:
        log(f"{model} / {mode}: complete ({len(done)} done)")
        return
    log(f"{model} / {mode}: {len(todo)} to run ({len(done)} already done)")

    runner = MODE_RUNNERS[mode]
    write_lock = threading.Lock()
    n_correct = sum(1 for r in done.values() if r.get("correct"))
    n_done = len(done)

    def work(q: EvalQuestion) -> None:
        nonlocal n_correct, n_done
        try:
            result = runner(model, q, circuit_context, frontend_circuit, workdir_base)
        except Exception as exc:
            result = {"answer": "?", "raw": f"RUNNER ERROR: {exc}", "errors": [str(exc)],
                      "timed_out": False, "elapsed_s": 0.0, "tool_calls": 0}
        rec = {
            "question_id": q.question_id,
            "difficulty": q.difficulty,
            "category": q.category,
            "expected": q.expected,
            "model": model,
            "mode": mode,
            "correct": result.get("answer") == q.expected,
            **result,
        }
        with write_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
            n_done += 1
            if rec["correct"]:
                n_correct += 1
            log(f"{model} / {mode}: Q{q.question_id} -> {result.get('answer')} "
                f"(exp {q.expected}) {'OK' if rec['correct'] else 'X'}  "
                f"[{n_correct}/{n_done}]")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, q) for q in todo]
        for fut in as_completed(futures):
            fut.result()

    log(f"{model} / {mode}: DONE — {n_correct}/{n_done} correct "
        f"({100.0*n_correct/max(n_done,1):.1f}%)")


def main() -> int:
    ap = argparse.ArgumentParser(description="VeraGrid MCQ three-mode benchmark")
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--modes", nargs="+", default=MODES, choices=MODES)
    ap.add_argument("--questions-file", default=QUESTIONS_FILE)
    ap.add_argument("--circuit-file", default=CIRCUIT_FILE)
    ap.add_argument("--limit", type=int, default=0, help="Only first N questions (smoke test)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--backend", choices=["cursor", "claude-code"], default="cursor",
                    help="Model backend: cursor-agent CLI or the Claude Code CLI.")
    args = ap.parse_args()

    global _BACKEND
    _BACKEND = args.backend

    questions = load_questions(args.questions_file)
    if args.limit:
        questions = questions[: args.limit]

    with open(args.circuit_file, "r", encoding="utf-8") as f:
        frontend_circuit = json.load(f)
    circuit_context = build_benchmark_circuit_context(frontend_circuit)

    os.makedirs(OUT_DIR, exist_ok=True)
    workdir_base = tempfile.mkdtemp(prefix="vg_bench_")

    log(f"Benchmark: {len(questions)} questions, models={args.models}, modes={args.modes}, "
        f"workers={args.workers}, backend={args.backend}")
    t0 = time.time()
    try:
        for model in args.models:
            for mode in args.modes:
                run_sweep(model, mode, questions, circuit_context, frontend_circuit,
                          args.workers, workdir_base)
    finally:
        shutil.rmtree(workdir_base, ignore_errors=True)
    log(f"ALL SWEEPS COMPLETE in {(time.time()-t0)/60.0:.1f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
