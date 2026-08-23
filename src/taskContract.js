import crypto from "node:crypto";

const RISKS = new Set(["low", "medium", "high", "critical"]);
const MAX_ITEMS = 100;

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function list(value, maxLength = 500) {
  const source = Array.isArray(value) ? value : String(value ?? "").split("\n");
  return [...new Set(source.map((item) => text(item, maxLength)).filter(Boolean))].slice(0, MAX_ITEMS);
}

function safePath(value) {
  const candidate = text(value, 500).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!candidate) return "";
  if (candidate.startsWith("/") || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    throw new Error(`Proje dışına çıkan yol kullanılamaz: ${candidate}`);
  }
  return candidate;
}

export function validateTaskContract(contract) {
  const errors = [];
  if (!contract.goal) errors.push("Hedef gerekli");
  if (!contract.acceptanceCriteria.length) errors.push("En az bir kabul kriteri gerekli");
  if (!contract.allowedPaths.length) errors.push("En az bir izin verilen yol gerekli");
  const overlap = contract.allowedPaths.filter((item) => contract.forbiddenPaths.includes(item));
  if (overlap.length) errors.push(`Aynı yol hem izinli hem yasak olamaz: ${overlap.join(", ")}`);
  if (contract.risk === "critical" && !contract.approvalBoundaries.length) {
    errors.push("Kritik riskli görevde en az bir onay sınırı gerekli");
  }
  return errors;
}

export function normalizeTaskContract(input = {}, previous = null) {
  const now = new Date().toISOString();
  const contract = {
    version: 1,
    goal: text(input.goal, 4000),
    nonGoals: list(input.nonGoals),
    allowedPaths: [...new Set(list(input.allowedPaths).map(safePath).filter(Boolean))],
    forbiddenPaths: [...new Set(list(input.forbiddenPaths).map(safePath).filter(Boolean))],
    risk: RISKS.has(input.risk) ? input.risk : "medium",
    acceptanceCriteria: list(input.acceptanceCriteria, 1000),
    testCommands: list(input.testCommands, 1000),
    approvalBoundaries: list(input.approvalBoundaries, 1000),
    revision: Number(previous?.revision || 0) + 1,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  contract.errors = validateTaskContract(contract);
  contract.status = contract.errors.length ? "draft" : "ready";
  contract.fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    goal: contract.goal,
    nonGoals: contract.nonGoals,
    allowedPaths: contract.allowedPaths,
    forbiddenPaths: contract.forbiddenPaths,
    risk: contract.risk,
    acceptanceCriteria: contract.acceptanceCriteria,
    testCommands: contract.testCommands,
    approvalBoundaries: contract.approvalBoundaries,
  })).digest("hex");
  return contract;
}

export function draftTaskContract(goal = "") {
  return normalizeTaskContract({ goal, risk: "medium" });
}
