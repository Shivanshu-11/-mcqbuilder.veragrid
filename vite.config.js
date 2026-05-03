import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PSCAD_DIR = path.resolve(process.cwd(), "../PSCAD");
const OPF_SCRIPT = path.join(PSCAD_DIR, "web_opf_agent.py");
const MCQ_SCRIPT = path.join(PSCAD_DIR, "opf_mcq_generator_150.py");
const MCQ_ADVERSARIAL_SCRIPT = path.join(PSCAD_DIR, "opf_mcq_adversarial.py");
const MCQ_EVAL_SCRIPT = path.join(PSCAD_DIR, "evaluator.py");
const PROMPT_BUILDER_SCRIPT = path.join(PSCAD_DIR, "prompt_builder.py");
const EVAL_CIRCUIT_FILE = path.join(PSCAD_DIR, "eval_circuit.web.json");
const OPF_RESULTS_FILE = path.join(PSCAD_DIR, "opf_results.web.json");
const MCQ_RESULTS_FILE = path.join(PSCAD_DIR, "mcq_questions.web.json");
const MCQ_ADVERSARIAL_ALL_FILE = path.join(PSCAD_DIR, "mcq_all.web.json");
const MCQ_ADVERSARIAL_PROMOTED_FILE = path.join(PSCAD_DIR, "mcq_promoted.web.json");
const MCQ_EVAL_RESULTS_FILE = path.join(PSCAD_DIR, "mcq_eval_results.web.json");
const PROMPT_RESULTS_FILE = path.join(PSCAD_DIR, "model_prompt.web.txt");

async function resolvePythonBinary() {
  const candidates = [
    path.join(PSCAD_DIR, ".venv312", "bin", "python3"),
    path.join(PSCAD_DIR, ".venv312", "bin", "python"),
    "python3",
    "python",
  ];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return "python3";
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function createAgentApiPlugin() {
  return {
    name: "veragrid-agent-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          next();
          return;
        }

        try {
          if (req.method === "POST" && req.url === "/api/run-opf") {
            const body = await readJsonBody(req);
            const modelPath = path.join(PSCAD_DIR, "web_model_input.json");
            if (body.model) {
              await fs.writeFile(modelPath, JSON.stringify(body.model, null, 2), "utf-8");
            }

            const pythonBin = await resolvePythonBinary();
            const args = [OPF_SCRIPT, "--results-output", OPF_RESULTS_FILE];
            if (body.model) args.push("--json-file", modelPath);

            const { stdout, stderr } = await execFileAsync(pythonBin, args, {
              cwd: PSCAD_DIR,
              maxBuffer: 20 * 1024 * 1024,
            });
            const resultsRaw = await fs.readFile(OPF_RESULTS_FILE, "utf-8");
            sendJson(res, 200, {
              ok: true,
              stdout,
              stderr,
              results: JSON.parse(resultsRaw),
            });
            return;
          }

          if (req.method === "POST" && req.url === "/api/generate-mcq") {
            const body = await readJsonBody(req);
            if (body.opfResults) {
              await fs.writeFile(OPF_RESULTS_FILE, JSON.stringify(body.opfResults, null, 2), "utf-8");
            }

            const pythonBin = await resolvePythonBinary();
            const seed = Number.isFinite(Number(body.seed)) ? String(Number(body.seed)) : "42";
            const easy = Number.isFinite(Number(body.easy)) ? String(Math.max(0, Number(body.easy))) : "50";
            const medium = Number.isFinite(Number(body.medium)) ? String(Math.max(0, Number(body.medium))) : "50";
            const hard = Number.isFinite(Number(body.hard)) ? String(Math.max(0, Number(body.hard))) : "50";

            const generationMode = String(body.mode || "templates").toLowerCase();

            if (generationMode === "adversarial") {
              const claudeApiKey = typeof body.claudeApiKey === "string" ? body.claudeApiKey.trim() : "";
              const openAiApiKey = typeof body.openAiApiKey === "string" ? body.openAiApiKey.trim() : "";
              const genModel = String(body.genModel || "claude-sonnet-4-5").trim();
              const solverModel = String(body.solverModel || "claude-sonnet-4-5").trim();

              const providerOf = (m) => {
                const lower = String(m || "").toLowerCase();
                if (lower.startsWith("claude")) return "anthropic";
                if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
                  return "openai";
                }
                return "unknown";
              };
              const needAnthropic = providerOf(genModel) === "anthropic" || providerOf(solverModel) === "anthropic";
              const needOpenAi = providerOf(genModel) === "openai" || providerOf(solverModel) === "openai";

              if (providerOf(genModel) === "unknown" || providerOf(solverModel) === "unknown") {
                sendJson(res, 400, {
                  ok: false,
                  error:
                    `Unknown model provider for gen='${genModel}' solver='${solverModel}'. ` +
                    "Pick a Claude (claude-...) or GPT/o-series (gpt-..., o1, o3, o4...) model.",
                });
                return;
              }
              if (needAnthropic && !claudeApiKey) {
                sendJson(res, 400, {
                  ok: false,
                  error:
                    "A Claude model was selected but no Anthropic API key was provided. " +
                    "Paste it in the Anthropic API key field above.",
                });
                return;
              }
              if (needOpenAi && !openAiApiKey) {
                sendJson(res, 400, {
                  ok: false,
                  error:
                    "A GPT/o-series model was selected but no OpenAI API key was provided. " +
                    "Paste it in the OpenAI API key field above.",
                });
                return;
              }

              const rounds = Number.isFinite(Number(body.rounds))
                ? String(Math.max(1, Math.min(5, Number(body.rounds))))
                : "2";

              const args = [
                MCQ_ADVERSARIAL_SCRIPT,
                "--input",
                OPF_RESULTS_FILE,
                "--out-all",
                MCQ_ADVERSARIAL_ALL_FILE,
                "--out-promoted",
                MCQ_ADVERSARIAL_PROMOTED_FILE,
                "--out-md",
                "",
                "--out-web",
                MCQ_RESULTS_FILE,
                "--seed",
                seed,
                "--easy",
                easy,
                "--medium",
                medium,
                "--hard",
                hard,
                "--rounds",
                rounds,
                "--gen-model",
                genModel,
                "--solver-model",
                solverModel,
              ];
              if (claudeApiKey) {
                args.push("--api-key", claudeApiKey);
              }
              if (openAiApiKey) {
                args.push("--openai-api-key", openAiApiKey);
              }
              const childEnv = { ...process.env };
              if (claudeApiKey) childEnv.ANTHROPIC_API_KEY = claudeApiKey;
              if (openAiApiKey) childEnv.OPENAI_API_KEY = openAiApiKey;

              const { stdout, stderr } = await execFileAsync(pythonBin, args, {
                cwd: PSCAD_DIR,
                maxBuffer: 32 * 1024 * 1024,
                env: childEnv,
                timeout: 15 * 60 * 1000,
              });
              let mcqPayload = null;
              try {
                const mcqRaw = await fs.readFile(MCQ_RESULTS_FILE, "utf-8");
                mcqPayload = JSON.parse(mcqRaw);
              } catch {
                mcqPayload = null;
              }
              const totalQuestions = mcqPayload?.metadata?.total_questions || 0;
              if (!mcqPayload || totalQuestions === 0) {
                sendJson(res, 200, {
                  ok: false,
                  error:
                    "Adversarial pipeline finished but produced 0 questions. " +
                    "See the diagnostics below for the model's raw output and parsing errors.",
                  stdout,
                  stderr,
                  mcq: mcqPayload,
                });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                stdout,
                stderr,
                mcq: mcqPayload,
              });
              return;
            }

            const args = [
              MCQ_SCRIPT,
              "--input",
              OPF_RESULTS_FILE,
              "--output",
              MCQ_RESULTS_FILE,
              "--seed",
              seed,
              "--easy",
              easy,
              "--medium",
              medium,
              "--hard",
              hard,
            ];
            const { stdout, stderr } = await execFileAsync(pythonBin, args, {
              cwd: PSCAD_DIR,
              maxBuffer: 20 * 1024 * 1024,
            });
            const mcqRaw = await fs.readFile(MCQ_RESULTS_FILE, "utf-8");
            sendJson(res, 200, {
              ok: true,
              stdout,
              stderr,
              mcq: JSON.parse(mcqRaw),
            });
            return;
          }

          if (req.method === "POST" && req.url === "/api/evaluate-model") {
            const body = await readJsonBody(req);
            const pythonBin = await resolvePythonBinary();
            const model = String(body.model || "gpt-4o").trim() || "gpt-4o";
            const mode = String(body.mode || "no_tool_use").trim() || "no_tool_use";
            const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
            const openAiApiKey = typeof body.openAiApiKey === "string" ? body.openAiApiKey.trim() : "";
            const claudeApiKey = typeof body.claudeApiKey === "string" ? body.claudeApiKey.trim() : "";
            const cursorApiKey = typeof body.cursorApiKey === "string" ? body.cursorApiKey.trim() : "";
            const circuitModel = body.circuitModel && typeof body.circuitModel === "object" ? body.circuitModel : null;
            const args = [
              MCQ_EVAL_SCRIPT,
              "--model",
              model,
              "--mode",
              mode,
              "--questions-file",
              MCQ_RESULTS_FILE,
              "--output",
              MCQ_EVAL_RESULTS_FILE,
              "--delay",
              "0",
            ];
            if (circuitModel) {
              await fs.writeFile(EVAL_CIRCUIT_FILE, JSON.stringify(circuitModel, null, 2), "utf-8");
              args.push("--circuit-file", EVAL_CIRCUIT_FILE);
            }
            if (prompt) {
              args.push("--system-prompt", prompt);
            }
            if (openAiApiKey) {
              args.push("--openai-api-key", openAiApiKey);
            }
            if (claudeApiKey) {
              args.push("--claude-api-key", claudeApiKey);
            }
            if (cursorApiKey) {
              args.push("--cursor-api-key", cursorApiKey);
            }

            const { stdout, stderr } = await execFileAsync(pythonBin, args, {
              cwd: PSCAD_DIR,
              maxBuffer: 20 * 1024 * 1024,
            });
            const evaluationRaw = await fs.readFile(MCQ_EVAL_RESULTS_FILE, "utf-8");
            sendJson(res, 200, {
              ok: true,
              stdout,
              stderr,
              evaluation: JSON.parse(evaluationRaw),
            });
            return;
          }

          if (req.method === "POST" && req.url === "/api/build-prompt") {
            const body = await readJsonBody(req);
            const modelPath = path.join(PSCAD_DIR, "web_model_input.json");
            if (!body.model || typeof body.model !== "object") {
              sendJson(res, 400, { ok: false, error: "Model JSON is required to build prompt." });
              return;
            }
            await fs.writeFile(modelPath, JSON.stringify(body.model, null, 2), "utf-8");

            const pythonBin = await resolvePythonBinary();
            const answerFormat = String(body.answerFormat || "letter_only");
            const args = [
              PROMPT_BUILDER_SCRIPT,
              "--frontend-model-file",
              modelPath,
              "--answer-format",
              answerFormat,
              "--output",
              PROMPT_RESULTS_FILE,
            ];
            const { stdout, stderr } = await execFileAsync(pythonBin, args, {
              cwd: PSCAD_DIR,
              maxBuffer: 20 * 1024 * 1024,
            });
            const prompt = await fs.readFile(PROMPT_RESULTS_FILE, "utf-8");
            sendJson(res, 200, {
              ok: true,
              stdout,
              stderr,
              prompt,
            });
            return;
          }

          sendJson(res, 404, { ok: false, error: "API route not found." });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error?.message || String(error),
            stderr: error?.stderr || "",
            stdout: error?.stdout || "",
          });
        }
      });
    },
  };
}

// https://vite.dev/config/
// GitHub Pages project URL: https://<user>.github.io/<repo>/
// In GitHub Actions, GITHUB_REPOSITORY is "owner/repo" — base must be "/<repo>/".
function productionBase() {
  if (process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
    return `/${repo}/`;
  }
  // Local `npm run build` (no Actions): keep in sync with your GitHub repo name
  return "/-mcqbuilder.veragrid/";
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), createAgentApiPlugin()],
  base: mode === 'development' ? '/' : productionBase(),
}));
