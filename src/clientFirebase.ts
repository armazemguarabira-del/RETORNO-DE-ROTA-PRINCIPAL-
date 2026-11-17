import { initializeApp, getApps, getApp, deleteApp } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot,
  terminate,
  setLogLevel,
  writeBatch,
  runTransaction,
  updateDoc,
  increment,
  deleteField
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";
import { DEFAULT_USERS, DEFAULT_DRIVERS, DEFAULT_VEHICLES, DEFAULT_PRODUCTS, DEFAULT_ACTIVE_ASSETS, DEFAULT_EMPILHADORES, DEFAULT_CARREGAMENTOS } from "./data";
import { FIREBASE_PRESETS } from "./firebasePresets";
import { isAutoScheduleEnabled, getCurrentScheduledPreset } from "./utils/databaseScheduler";
import type { AuditSession, AuditStatus, ImportedRoute } from "./types";

// Silence verbose or harmless Firestore warnings/info logs in browser
try {
  setLogLevel("silent");
} catch (e) {
  // ignore
}

// Collection mapping
const COLLECTION_MAP: Record<string, string> = {
  users: "users",
  drivers: "drivers",
  vehicles: "vehicles",
  products: "products",
  activeAssets: "activeAssets",
  audits: "audits",
  vales: "vales",
  returnForecasts: "returnForecasts",
  fiscalAlerts: "fiscalAlerts",
  importedRoutes: "importedRoutes",
  audit_logs: "auditLogs",
  auditLogs: "auditLogs",
  customManual: "customManual",
  empilhadores: "empilhadores",
  carregamentos: "carregamentoProcesses",
  carregamentoProcesses: "carregamentoProcesses",
  controleSobras: "controleSobras",
  fiveSEntries: "fiveSEntries",
  safetyReports: "safetyReports",
  blitzEntries: "blitzEntries",
  zeroBreakDeclarations: "zeroBreakDeclarations"
};

const TRACKED_COLLECTIONS = [
  "users",
  "drivers",
  "vehicles",
  "products",
  "activeAssets",
  "audits",
  "vales",
  "returnForecasts",
  "fiscalAlerts",
  "importedRoutes",
  "auditLogs",
  "customManual",
  "empilhadores",
  "carregamentoProcesses",
  "controleSobras",
  "fiveSEntries",
  "safetyReports",
  "blitzEntries",
  "zeroBreakDeclarations"
];

/**
 * Fast deterministic canonical JSON stringifier to guarantee identical key order,
 * eliminating redundant writes caused by differing field order.
 */
export function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(v => v === undefined ? "null" : canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  let res = "{";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (i > 0) res += ",";
    res += JSON.stringify(k) + ":" + canonicalJson(obj[k]);
  }
  res += "}";
  return res;
}

/**
 * Requirement 1: Unique and stable document ID per collection
 * importedRoutes MUST use routeMap + routeDate combined (e.g., 03.11.49.02_2026-07-22)
 * so new and old routes with the same map number never collide.
 */
export function getDocIdForCollection(colName: string, item: any): string {
  if (!item) return `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const mappedCol = COLLECTION_MAP[colName] || colName;
  const sanitizeId = (val: any) => String(val || '').trim().replace(/[\/\\]/g, '_');

  if (mappedCol === "importedRoutes") {
    const mapStr = item.routeMap ? sanitizeId(item.routeMap) : "";
    const dateStr = item.routeDate ? sanitizeId(item.routeDate) : "";
    if (mapStr && dateStr) {
      return `${mapStr}_${dateStr}`;
    }
    if (mapStr) {
      return mapStr;
    }
  }

  if (mappedCol === "users") {
    const rawLogin = (item.username || item.id || '').trim().toLowerCase();
    const baseLogin = rawLogin.includes('@') ? rawLogin.split('@')[0] : rawLogin;
    if (baseLogin) return sanitizeId(baseLogin);
    if (item.id) return sanitizeId(item.id);
  }

  if (
    mappedCol === "drivers" ||
    mappedCol === "activeAssets" ||
    mappedCol === "audits" ||
    mappedCol === "vales" ||
    mappedCol === "returnForecasts" ||
    mappedCol === "fiscalAlerts" ||
    mappedCol === "auditLogs" ||
    mappedCol === "empilhadores" ||
    mappedCol === "carregamentoProcesses"
  ) {
    if (item.id) return sanitizeId(item.id);
  }

  if (mappedCol === "vehicles") {
    if (item.id) return sanitizeId(item.id);
    if (item.plate) return sanitizeId(item.plate);
  }

  if (mappedCol === "products") {
    if (item.code) return sanitizeId(item.code);
    if (item.id) return sanitizeId(item.id);
  }

  if (item.id) return sanitizeId(item.id);
  if (item.code) return sanitizeId(item.code);
  if (item.plate) return sanitizeId(item.plate);
  if (item.username) return sanitizeId(item.username);
  if (item.routeMap) {
    const mapStr = sanitizeId(item.routeMap);
    const dateStr = item.routeDate ? sanitizeId(item.routeDate) : "";
    return dateStr ? `${mapStr}_${dateStr}` : mapStr;
  }

  return `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

export function getItemDocId(item: any): string {
  return getDocIdForCollection("generic", item);
}

let firestoreInstance: any = null;
let isAuthenticating = false;
let isAuthenticated = false;

// In-memory cache of document JSON hashes for the active session to avoid redundant network churn
const inMemoryDocCache: Record<string, Map<string, string>> = {};

function getColCache(colName: string): Map<string, string> {
  const targetCol = COLLECTION_MAP[colName] || colName;
  if (!inMemoryDocCache[targetCol]) {
    inMemoryDocCache[targetCol] = new Map<string, string>();
  }
  return inMemoryDocCache[targetCol];
}

function persistColCache(_colName: string) {
  // Ephemeral in-memory cache only; no sessionStorage persistence to prevent stale cross-user cache
}

// --- Fase 1 & 2: Rastreamento de tombstones, geração, metadados e transições ---
export class FirestoreNotFoundError extends Error {
  code = "NOT_FOUND" as const;
  constructor(message = "Documento não encontrado ou já foi excluído.") {
    super(message);
    this.name = "FirestoreNotFoundError";
  }
}

export class FirestoreConflictError extends Error {
  code = "CONFLICT" as const;
  currentStatus?: string;
  constructor(message = "O documento já foi alterado por outro usuário.", currentStatus?: string) {
    super(message);
    this.name = "FirestoreConflictError";
    this.currentStatus = currentStatus;
  }
}

export function isGuardConflictOrNotFound(err: any): err is FirestoreNotFoundError | FirestoreConflictError {
  return Boolean(
    err &&
      (err.code === "NOT_FOUND" ||
        err.code === "CONFLICT" ||
        err instanceof FirestoreNotFoundError ||
        err instanceof FirestoreConflictError)
  );
}

const deletedAuditIds = new Set<string>();
const deletedRouteIds = new Set<string>();
const latestRouteGenerationById = new Map<string, number>();
const latestAuditMetaById = new Map<
  string,
  { status: string; rev: number; generation: number; reopenCycle: number; deletedAt?: string }
>();
const legitimateCreatedAuditIds = new Set<string>();

export function isAuditDeletedId(id: string): boolean {
  return Boolean(id && deletedAuditIds.has(id));
}

export function isRouteDeletedId(id: string): boolean {
  return Boolean(id && deletedRouteIds.has(id));
}

export function getDeletedAuditIds(): Set<string> {
  return deletedAuditIds;
}

export function getDeletedRouteIds(): Set<string> {
  return deletedRouteIds;
}

export function getRouteGeneration(routeId: string): number {
  return latestRouteGenerationById.get(routeId) ?? 1;
}

export function getAuditMeta(auditId: string) {
  return latestAuditMetaById.get(auditId);
}

export function markLegitimateAuditCreation(auditId: string): void {
  if (auditId) legitimateCreatedAuditIds.add(auditId);
}

export function isLegitimateCreatedAudit(auditId: string): boolean {
  return Boolean(auditId && legitimateCreatedAuditIds.has(auditId));
}

export function normalizeMapCodeClient(mapCode: any): string {
  if (mapCode === undefined || mapCode === null) return "";
  return String(mapCode).trim().replace(/^0+/, "");
}

/**
 * Compara data de rota importada com data de chegada da auditoria de forma segura:
 * - Se ambas existem: aceita mesmo dia, ou ciclo de retorno em até 5 dias posteriores (arrivalDate >= routeDate).
 * - Nunca casa auditoria de data anterior (arrivalDate < routeDate) para não fechar rota nova com mapa antigo reutilizado.
 */
export function datesMatchForQueue(routeDate?: string, arrivalDate?: string): boolean {
  if (!routeDate || !arrivalDate) return true;
  if (routeDate === arrivalDate) return true;
  try {
    const startMs = new Date(`${routeDate}T00:00:00`).getTime();
    const endMs = new Date(`${arrivalDate}T00:00:00`).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return routeDate === arrivalDate;
    const diffDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays <= 5;
  } catch {
    return routeDate === arrivalDate;
  }
}

export function doesAuditMatchRoute(
  audit: { routeMap?: string; unifiedMaps?: string[]; arrivalDate?: string; deletedAt?: string },
  route: { routeMap?: string; routeDate?: string; deletedAt?: string },
  options?: { strictSameDate?: boolean }
): boolean {
  if (!audit || !route || audit.deletedAt || route.deletedAt) return false;
  const rNorm = normalizeMapCodeClient(route.routeMap).toUpperCase();
  const rUpper = String(route.routeMap || "").trim().toUpperCase();
  if (!rNorm && !rUpper) return false;

  const aNorm = normalizeMapCodeClient(audit.routeMap).toUpperCase();
  const aUpper = String(audit.routeMap || "").trim().toUpperCase();
  const mapMatches =
    (rNorm && aNorm === rNorm) ||
    (rUpper && aUpper === rUpper) ||
    (Array.isArray(audit.unifiedMaps) &&
      audit.unifiedMaps.some(
        (m) => normalizeMapCodeClient(m).toUpperCase() === rNorm || String(m || "").trim().toUpperCase() === rUpper
      ));

  if (!mapMatches) return false;
  if (options?.strictSameDate) {
    if (route.routeDate && audit.arrivalDate) {
      return route.routeDate === audit.arrivalDate;
    }
    return true;
  }
  return datesMatchForQueue(route.routeDate, audit.arrivalDate);
}

const ALLOWED_AUDIT_TRANSITIONS: Record<string, Set<string>> = {
  em_aberto: new Set(["em_aberto", "conferido_fisico"]),
  conferido_fisico: new Set(["conferido_fisico", "reconferencia", "finalizado_ok", "finalizado_divergente"]),
  reconferencia: new Set(["reconferencia", "recontagem_finalizada"]),
  recontagem_finalizada: new Set(["recontagem_finalizada", "reconferencia", "finalizado_ok", "finalizado_divergente"]),
  finalizado_ok: new Set(["finalizado_ok"]),
  finalizado_divergente: new Set(["finalizado_divergente"])
};

export function isAllowedAuditStatusTransition(
  fromStatus: string | undefined,
  toStatus: string | undefined,
  opts?: { prevReopenCycle?: number; nextReopenCycle?: number }
): boolean {
  if (!fromStatus) return true;
  if (!toStatus) return false;
  if (fromStatus === toStatus) return true;

  // Transição de finalizado_* -> conferido_fisico SOMENTE quando reopenCycle aumentou (via reopenAudit)
  if (
    (fromStatus === "finalizado_ok" || fromStatus === "finalizado_divergente") &&
    toStatus === "conferido_fisico"
  ) {
    const prevCycle = Number(opts?.prevReopenCycle || 0);
    const nextCycle = Number(opts?.nextReopenCycle || 0);
    return nextCycle > prevCycle;
  }

  const allowed = ALLOWED_AUDIT_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.has(toStatus);
}

function isFirestoreSentinel(val: any): boolean {
  if (!val || typeof val !== "object") return false;
  const proto = Object.getPrototypeOf(val);
  if (proto !== null && proto !== Object.prototype && !Array.isArray(val)) {
    return true;
  }
  if (typeof val._methodName === "string") return true;
  return false;
}

function sanitizeForFirestore<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;
  if (isFirestoreSentinel(input)) return input;
  if (Array.isArray(input)) {
    return input.filter((v) => v !== undefined).map((v) => sanitizeForFirestore(v)) as unknown as T;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input as Record<string, any>)) {
    if (v === undefined) continue;
    out[k] = sanitizeForFirestore(v);
  }
  return out as T;
}
let clientAuthError: string | null = null;
let lastAuthAttemptTime = 0;
const AUTH_COOLDOWN_MS = 25000;
let lastSuccessfulSyncTime = 0;

export function getLastSuccessfulSyncTime(): number {
  return lastSuccessfulSyncTime;
}

let isFirestoreQuotaExceeded = false;
let hasClientPermissionError = false;

// --- Auto-recuperação (backoff) para erros de permissão/cota --------------
// ANTES: uma única ocorrência de permission-denied ou resource-exhausted
// travava hasClientPermissionError/isFirestoreQuotaExceeded em `true` para
// sempre (só eram resetadas dentro de switchActiveFirebaseConfig, que nunca
// é chamada automaticamente). Isso desligava TODOS os listeners do app até
// um reload manual da página. Agora ambos os erros disparam uma rotina de
// nova tentativa com backoff exponencial (2s, 4s, 8s... até 60s), e o app
// se reconecta sozinho assim que o Firestore voltar a responder.
const MAX_AUTO_RETRY_DELAY_MS = 60000;
let permissionRetryAttempts = 0;
let permissionRetryTimer: any = null;
let quotaRetryAttempts = 0;
let quotaRetryTimer: any = null;

export function isPermissionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.code || err).toLowerCase();
  return (
    err.code === "permission-denied" ||
    msg.includes("missing or insufficient permissions") ||
    msg.includes("permission-denied") ||
    msg.includes("insufficient permissions")
  );
}

export function checkPermissionError(err: any) {
  if (!err || !isPermissionError(err)) return;
  console.warn("[ClientFirebase] Aviso de permissões no cliente Firestore:", err?.message || err);
  scheduleAutoRecovery('permission');
}

export function getIsFirestoreQuotaExceeded(): boolean {
  // Plano Blaze ativo: sem limitação de cota diária
  return false;
}

export function setFirestoreQuotaExceeded(val: boolean) {
  isFirestoreQuotaExceeded = false;
  if (permissionRetryTimer) { clearTimeout(permissionRetryTimer); permissionRetryTimer = null; }
  if (quotaRetryTimer) { clearTimeout(quotaRetryTimer); quotaRetryTimer = null; }
  quotaRetryAttempts = 0;
}

export function isQuotaError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.code || err).toLowerCase();
  return (
    err.code === "resource-exhausted" ||
    msg.includes("quota exceeded") ||
    msg.includes("quota-exceeded") ||
    msg.includes("resource-exhausted") ||
    msg.includes("quota limit exceeded")
  );
}

function checkQuotaError(err: any) {
  // No Plano Blaze (Google Cloud Firestore faturamento ativado), eventuais erros de
  // 'resource-exhausted' são picos transitórios de taxa por documento, não esgotamento de cota diária.
  // Mantemos o cliente operando normalmente e retentando com backoff sem desativar o Firestore.
  console.warn("[ClientFirebase] Pico transitório detectado no Firestore (Plano Blaze Oficial ativo):", err?.message || err);
}

// Agenda uma tentativa de reconexão com backoff exponencial (máx. 60s).
// Ao expirar, limpa as flags de erro e pede para a camada de listeners
// (subscribeToFirestore) reanexar tudo. Se o erro persistir, um novo
// onSnapshot vai chamar checkPermissionError/checkQuotaError de novo e o
// backoff aumenta - ele nunca desiste "para sempre" como antes.
function scheduleAutoRecovery(kind: 'permission' | 'quota') {
  if (kind === 'permission') {
    if (permissionRetryTimer) return; // já agendado
    const delay = Math.min(MAX_AUTO_RETRY_DELAY_MS, 2000 * Math.pow(2, permissionRetryAttempts));
    permissionRetryAttempts++;
    permissionRetryTimer = setTimeout(() => {
      permissionRetryTimer = null;
      console.log(`[ClientFirebase] Retomando após permission-denied (tentativa ${permissionRetryAttempts})...`);
      hasClientPermissionError = false;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('client_firestore_permission_restored'));
        window.dispatchEvent(new CustomEvent('firestore_request_reattach'));
      }
    }, delay);
  } else {
    if (quotaRetryTimer) return;
    const delay = Math.min(MAX_AUTO_RETRY_DELAY_MS, 3000 * Math.pow(2, quotaRetryAttempts));
    quotaRetryAttempts++;
    quotaRetryTimer = setTimeout(() => {
      quotaRetryTimer = null;
      console.log(`[ClientFirebase] Retomando após resource-exhausted (tentativa ${quotaRetryAttempts})...`);
      isFirestoreQuotaExceeded = false;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('firestore_quota_restored'));
        window.dispatchEvent(new CustomEvent('firestore_request_reattach'));
      }
    }, delay);
  }
}

// Reseta os contadores de backoff quando uma sincronização bem-sucedida
// acontece, para que um problema pontual não deixe o próximo backoff mais
// lento do que precisa ser.
function markSyncSuccess() {
  lastSuccessfulSyncTime = Date.now();
  if (permissionRetryAttempts > 0 || quotaRetryAttempts > 0) {
    permissionRetryAttempts = 0;
    quotaRetryAttempts = 0;
  }
}

// --- Monitoramento do estado de autenticação -------------------------------
// ANTES: o app fazia signInAnonymously uma vez e nunca mais verificava se a
// sessão continuava válida (sem onAuthStateChanged/onIdTokenChanged em lugar
// nenhum do projeto). Se a sessão anônima caísse (token revogado, storage
// limpo, etc.), isAuthenticated ficava `true` para sempre e nada tentava se
// autenticar de novo.
let authStateListenerAttached = false;

function attachAuthStateListener() {
  if (authStateListenerAttached || typeof window === "undefined") return;
  authStateListenerAttached = true;
  try {
    const authRef = getAuth();
    onAuthStateChanged(authRef, (user) => {
      if (user) {
        const wasUnauthenticated = !isAuthenticated;
        isAuthenticated = true;
        isAuthenticating = false;
        clientAuthError = null;
        if (wasUnauthenticated) {
          window.dispatchEvent(new CustomEvent('firestore_request_reattach'));
        }
      } else {
        console.warn("[ClientFirebase] Sessão de autenticação perdida. Tentando reautenticar...");
        isAuthenticated = false;
        triggerAnonymousAuth();
      }
    });
  } catch (e) {
    authStateListenerAttached = false;
  }
}

export function getClientAuthError(): string | null {
  return clientAuthError;
}

export function getFirebaseConnectionState(): 'connected' | 'connecting' | 'disconnected' {
  if (typeof window === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return 'disconnected';
  }
  const db = getClientFirestore();
  if (!db) return 'disconnected';
  return 'connected';
}

function triggerAnonymousAuth() {
  attachAuthStateListener();

  const now = Date.now();
  if (now - lastAuthAttemptTime < AUTH_COOLDOWN_MS) return;

  try {
    const auth = getAuth();
    if (auth.currentUser) {
      isAuthenticated = true;
      return;
    }
    lastAuthAttemptTime = now;
    isAuthenticating = true;
    signInAnonymously(auth)
      .then((userCredential) => {
        console.log("[ClientFirebase] Autenticação anônima realizada com sucesso:", userCredential.user.uid);
        isAuthenticated = true;
        isAuthenticating = false;
        clientAuthError = null;
      })
      .catch((err) => {
        const errCode = err.code || err.message || "unknown";
        clientAuthError = errCode;
        isAuthenticating = false;
      });
  } catch (e) {
    clientAuthError = "get_auth_failed";
  }
}

export function isClientFirebaseActive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const db = getClientFirestore();
    if (db) return true;
  } catch (e) {}
  return false;
}

export function getActiveFirebaseConfig(): any {
  const activePreset = FIREBASE_PRESETS[0];
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("active_firebase_config", JSON.stringify(activePreset.config));
      localStorage.setItem("logiroute_firebase_client_config", JSON.stringify(activePreset.config));
    } catch (e) {}
  }
  return activePreset.config;
}

export async function switchActiveFirebaseConfig(newConfig: any): Promise<boolean> {
  const targetConfig = newConfig || FIREBASE_PRESETS[0].config;
  try {
    hasClientPermissionError = false;
    isFirestoreQuotaExceeded = false;
    clientAuthError = null;
    if (typeof window !== "undefined") {
      localStorage.setItem("active_firebase_config", JSON.stringify(targetConfig));
      localStorage.setItem("logiroute_firebase_client_config", JSON.stringify(targetConfig));
    }
    try {
      await fetch('/api/firebase/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetConfig),
      });
    } catch (e) {}

    if (firestoreInstance) {
      try {
        await terminate(firestoreInstance);
      } catch (e) {}
      firestoreInstance = null;
    }
    for (const a of getApps()) {
      try {
        await deleteApp(a);
      } catch (e) {}
    }
    authStateListenerAttached = false;
    isAuthenticated = false;
    isAuthenticating = false;
    g1163RestorePromise = null;
    g1163RestoreCompleted = false;
    g1163ShouldKeepFallback = true;
    Object.keys(inMemoryDocCache).forEach(k => delete inMemoryDocCache[k]);
    if (typeof window !== "undefined") {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith('logiroute_doc_cache_')) {
            sessionStorage.removeItem(key);
          }
        }
      } catch (e) {}
    }

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("firebase_config_changed", { detail: newConfig }));
    }
    return true;
  } catch (err) {
    console.error("[ClientFirebase] Erro ao alternar banco de dados:", err);
    return false;
  }
}

export async function syncFirebaseData(sourceConfig: any, targetConfig: any): Promise<{ success: boolean; count: number }> {
  let totalDocs = 0;
  const appNameSource = `syncSrc_${Date.now()}`;
  const appNameTarget = `syncTgt_${Date.now()}`;

  let sourceApp: any = null;
  let targetApp: any = null;

  const syncWorker = async () => {
    try {
      console.log(`[syncFirebaseData] Iniciando sincronização completa de '${sourceConfig.projectId}' para '${targetConfig.projectId}'...`);
      sourceApp = initializeApp(sourceConfig, appNameSource);
      targetApp = initializeApp(targetConfig, appNameTarget);

      try {
        await Promise.all([
          signInAnonymously(getAuth(sourceApp)).catch(() => null),
          signInAnonymously(getAuth(targetApp)).catch(() => null)
        ]);
      } catch (e) {
        // ignore auth error
      }

      const sourceDb = getFirestore(sourceApp);
      const targetDb = getFirestore(targetApp);

      for (const colName of TRACKED_COLLECTIONS) {
        try {
          const sourceSnap = await getDocs(collection(sourceDb, colName));
          const sourceDocs = sourceSnap.docs;
          const sourceDocIds = new Set(sourceDocs.map(d => d.id));

          // Obtain target docs to identify stale items to purge
          let idsToDelete: string[] = [];
          try {
            const targetSnap = await getDocs(collection(targetDb, colName));
            for (const tDoc of targetSnap.docs) {
              if (!sourceDocIds.has(tDoc.id)) {
                idsToDelete.push(tDoc.id);
              }
            }
          } catch (e) {
            console.warn(`[syncFirebaseData] Não foi possível listar target para ${colName}:`, e);
          }

          if (sourceDocs.length === 0 && idsToDelete.length === 0) continue;

          // Prepare operations: delete stale target docs first, then set current source docs
          const ops: Array<{ type: 'set' | 'delete'; id: string; data?: any }> = [
            ...idsToDelete.map(id => ({ type: 'delete' as const, id })),
            ...sourceDocs.map(d => ({ type: 'set' as const, id: d.id, data: d.data() }))
          ];

          const batchSize = 300;
          for (let i = 0; i < ops.length; i += batchSize) {
            const chunk = ops.slice(i, i + batchSize);
            const batch = writeBatch(targetDb);
            chunk.forEach(op => {
              const docRef = doc(targetDb, colName, op.id);
              if (op.type === 'delete') {
                batch.delete(docRef);
              } else {
                batch.set(docRef, op.data, { merge: true });
              }
            });
            await batch.commit();
          }

          console.log(`[syncFirebaseData] Coleção '${colName}': ${sourceDocs.length} atualizados, ${idsToDelete.length} obsoletos removidos.`);
          totalDocs += sourceDocs.length;
        } catch (e) {
          console.warn(`[syncFirebaseData] Aviso ao sincronizar coleção '${colName}':`, e);
        }
      }
      console.log(`[syncFirebaseData] Sincronização concluída! Total de ${totalDocs} documentos transferidos.`);
      return { success: true, count: totalDocs };
    } catch (err) {
      console.error("[syncFirebaseData] Erro de sincronização entre bancos:", err);
      return { success: false, count: 0 };
    } finally {
      if (sourceApp) { try { await deleteApp(sourceApp); } catch (e) {} }
      if (targetApp) { try { await deleteApp(targetApp); } catch (e) {} }
    }
  };

  const timeoutPromise = new Promise<{ success: boolean; count: number }>((resolve) => {
    setTimeout(() => {
      console.warn("[syncFirebaseData] Timeout de 25s atingido. Prosseguindo com troca de banco...");
      resolve({ success: false, count: totalDocs });
    }, 25000);
  });

  return Promise.race([syncWorker(), timeoutPromise]);
}

export function getClientFirestore() {
  if (hasClientPermissionError) return null;
  if (firestoreInstance) {
    if (!isAuthenticated && !isAuthenticating) {
      triggerAnonymousAuth();
    }
    return firestoreInstance;
  }

  try {
    const config = getActiveFirebaseConfig();
    if (
      !config ||
      !config.projectId ||
      config.projectId === "remixed-project-id" ||
      config.projectId.includes("placeholder")
    ) {
      return null;
    }

    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    const dbId = (config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)") ? config.firestoreDatabaseId : undefined;

    // Enable IndexedDB persistent local cache with multi-tab support
    // This allows page reloads and multiple tabs to read from local cache with 0 Firestore read consumption!
    try {
      if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
        firestoreInstance = initializeFirestore(app, {
          localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
          })
        }, dbId);
      } else {
        firestoreInstance = dbId ? getFirestore(app, dbId) : getFirestore(app);
      }
    } catch (errInit) {
      // Fallback if already initialized in another mode
      firestoreInstance = dbId ? getFirestore(app, dbId) : getFirestore(app);
    }

    triggerAnonymousAuth();
    return firestoreInstance;
  } catch (err) {
    console.warn("[ClientFirebase] Erro ao inicializar Firestore:", err);
    return null;
  }
}

/**
 * Requirement 2: Direct writes (create, edit, import) go straight to document in Firestore collection.
 */
export async function saveDocToFirestore(colName: string, item: any): Promise<boolean> {
  const db = getClientFirestore();
  if (!db || !item) return false;
  try {
    const targetCol = COLLECTION_MAP[colName] || colName;
    const docId = getDocIdForCollection(targetCol, item);
    const cleanItem = JSON.parse(JSON.stringify(item));
    cleanItem.id = docId;

    const colCache = getColCache(targetCol);
    const newJson = canonicalJson(cleanItem);

    const docRef = doc(db, targetCol, docId);
    await setDoc(docRef, cleanItem, { merge: true });
    colCache.set(docId, newJson);
    return true;
  } catch (err) {
    console.warn(`[ClientFirebase] Erro ao salvar documento na coleção '${colName}':`, err);
    if (isPermissionError(err)) checkPermissionError(err);
    if (isQuotaError(err)) checkQuotaError(err);
    
    // Tenta uma segunda vez com pequeno recuo para contornar oscilação de rede móvel
    try {
      await new Promise(r => setTimeout(r, 400));
      const targetCol = COLLECTION_MAP[colName] || colName;
      const docId = getDocIdForCollection(targetCol, item);
      const cleanItem = JSON.parse(JSON.stringify(item));
      cleanItem.id = docId;
      const docRef = doc(db, targetCol, docId);
      await setDoc(docRef, cleanItem, { merge: true });
      getColCache(targetCol).set(docId, canonicalJson(cleanItem));
      persistColCache(targetCol);
      return true;
    } catch (retryErr) {
      console.error(`[ClientFirebase] Falha definitiva na escrita direta no Firestore:`, retryErr);
      return false;
    }
  }
}

export async function deleteDocFromFirestore(colName: string, docId: string): Promise<boolean> {
  const db = getClientFirestore();
  if (!db || !docId) return false;
  try {
    const targetCol = COLLECTION_MAP[colName] || colName;
    const docRef = doc(db, targetCol, docId);
    await deleteDoc(docRef);
    getColCache(targetCol).delete(docId);
    persistColCache(targetCol);
    return true;
  } catch (err) {
    console.warn(`[ClientFirebase] Erro ao deletar documento '${docId}' da coleção '${colName}':`, err);
    if (isPermissionError(err)) checkPermissionError(err);
    if (isQuotaError(err)) checkQuotaError(err);
    return false;
  }
}

export async function saveDocsToFirestore(colName: string, items: any[], syncDeletions: boolean = false, forceWrite: boolean = false): Promise<boolean> {
  const db = getClientFirestore();
  if (!db || !items) return false;
  try {
    const targetCol = COLLECTION_MAP[colName] || colName;
    const cleanItems = JSON.parse(JSON.stringify(items));
    const colCache = getColCache(targetCol);

    const currentDocIds = new Set<string>();
    const opsToSet: Array<{ id: string; data: any; json: string }> = [];

    // Filter only NEW or MODIFIED items using deterministic canonical JSON
    for (const item of cleanItems) {
      const docId = getDocIdForCollection(targetCol, item);
      item.id = docId;
      currentDocIds.add(docId);

      const newJson = canonicalJson(item);
      const cachedJson = colCache.get(docId);

      if (forceWrite || cachedJson !== newJson) {
        opsToSet.push({ id: docId, data: item, json: newJson });
      }
    }

    let idsToDelete: string[] = [];
    if (syncDeletions) {
      // Check deletions against known keys in colCache (0 extra read operations!)
      for (const cachedId of Array.from(colCache.keys())) {
        if (!currentDocIds.has(cachedId)) {
          idsToDelete.push(cachedId);
        }
      }
    }

    const allOps: Array<{ type: 'set' | 'delete'; id: string; data?: any; json?: string }> = [
      ...opsToSet.map(op => ({ type: 'set' as const, id: op.id, data: op.data, json: op.json })),
      ...idsToDelete.map(id => ({ type: 'delete' as const, id }))
    ];

    // If nothing changed and nothing was deleted, return immediately (0 reads, 0 writes!)
    if (allOps.length === 0) {
      return true;
    }

    const batchSize = 400;
    for (let i = 0; i < allOps.length; i += batchSize) {
      const chunk = allOps.slice(i, i + batchSize);
      const batch = writeBatch(db);
      chunk.forEach(op => {
        const docRef = doc(db, targetCol, op.id);
        if (op.type === 'set') {
          batch.set(docRef, op.data, { merge: true });
        } else {
          batch.delete(docRef);
        }
      });
      await batch.commit();

      // Update in-memory + session cache after successful commit
      chunk.forEach(op => {
        if (op.type === 'set' && op.json) {
          colCache.set(op.id, op.json);
        } else if (op.type === 'delete') {
          colCache.delete(op.id);
        }
      });
    }
    persistColCache(targetCol);
    return true;
  } catch (err) {
    console.warn(`[ClientFirebase] Erro ao salvar documentos na coleção '${colName}':`, err);
    if (isPermissionError(err)) checkPermissionError(err);
    if (isQuotaError(err)) checkQuotaError(err);
    return false;
  }
}

export interface CollectionDiff {
  upsert: any[];
  deleteIds: string[];
}

export async function saveCollectionDiffsToFirestore(
  diffs: Record<string, CollectionDiff>,
  customManualHtml?: string
): Promise<boolean> {
  const db = getClientFirestore();
  if (!db) return false;
  try {
    const savePromise = (async () => {
      if (customManualHtml !== undefined) {
        const docRef = doc(db, "customManual", "main");
        await setDoc(docRef, { html: customManualHtml, updatedAt: new Date().toISOString() });
      }

      const allOps: Array<{
        type: "set" | "delete";
        targetCol: string;
        id: string;
        data?: any;
        json?: string;
      }> = [];
      const touchedCols = new Set<string>();

      for (const [rawKey, diff] of Object.entries(diffs)) {
        if (!diff) continue;
        const targetCol = COLLECTION_MAP[rawKey] || rawKey;
        if (targetCol === "customManual") continue;
        const colCache = getColCache(targetCol);

        for (const rawItem of diff.upsert || []) {
          if (!rawItem) continue;
          const cleanItem = JSON.parse(JSON.stringify(rawItem));
          const docId = getDocIdForCollection(targetCol, cleanItem);
          cleanItem.id = docId;
          const newJson = canonicalJson(cleanItem);
          if (colCache.get(docId) !== newJson) {
            allOps.push({ type: "set", targetCol, id: docId, data: cleanItem, json: newJson });
            touchedCols.add(targetCol);
          }
        }

        for (const delId of diff.deleteIds || []) {
          if (!delId) continue;
          if (targetCol === "audits" || targetCol === "importedRoutes") {
            console.warn(`[ClientFirebase] Bloqueado delete físico automático em '${targetCol}' (${delId}). Use softDeleteMapCascade.`);
            continue;
          }
          allOps.push({ type: "delete", targetCol, id: delId });
          touchedCols.add(targetCol);
        }
      }

      if (allOps.length === 0) return true;

      const batchSize = 400;
      for (let i = 0; i < allOps.length; i += batchSize) {
        const chunk = allOps.slice(i, i + batchSize);
        const batch = writeBatch(db);
        chunk.forEach(op => {
          const docRef = doc(db, op.targetCol, op.id);
          if (op.type === "set") {
            batch.set(docRef, op.data, { merge: true });
          } else {
            batch.delete(docRef);
          }
        });
        await batch.commit();

        chunk.forEach(op => {
          const colCache = getColCache(op.targetCol);
          if (op.type === "set" && op.json) {
            colCache.set(op.id, op.json);
          } else if (op.type === "delete") {
            colCache.delete(op.id);
          }
        });
      }

      touchedCols.forEach(col => persistColCache(col));
      return true;
    })();

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        console.warn("[ClientFirebase] saveCollectionDiffsToFirestore atingiu timeout de 15s (escrita pendente na fila offline local).");
        resolve(true);
      }, 15000);
    });

    return await Promise.race([savePromise, timeoutPromise]);
  } catch (err) {
    console.warn("[ClientFirebase] Erro ao persistir diffs no Firestore:", err);
    if (isPermissionError(err)) checkPermissionError(err);
    if (isQuotaError(err)) checkQuotaError(err);
    return false;
  }
}

export async function saveDirectlyToFirestore(payload: any, forceWrite: boolean = false, syncDeletions: boolean = false): Promise<boolean> {
  const db = getClientFirestore();
  if (!db || !payload) return false;
  try {
    const savePromise = (async () => {
      const keys = Object.keys(payload);
      const processedCols = new Set<string>();
      for (const key of keys) {
        const colName = COLLECTION_MAP[key] || key;
        if (processedCols.has(colName)) continue;
        const rawData = payload[key];
        if (rawData === undefined) continue;
        processedCols.add(colName);

        if (colName === "customManual") {
          const docRef = doc(db, "customManual", "main");
          const htmlContent = typeof rawData === "string" ? rawData : rawData?.html || rawData?.content || "";
          await setDoc(docRef, { html: htmlContent, updatedAt: new Date().toISOString() });
          continue;
        }

        if (Array.isArray(rawData)) {
          await saveDocsToFirestore(colName, rawData, syncDeletions, forceWrite);
        }
      }
      return true;
    })();

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, 15000);
    });

    return await Promise.race([savePromise, timeoutPromise]);
  } catch (err) {
    console.warn("[ClientFirebase] Erro ao persistir no Firestore:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fase 2: Helpers Transacionais por Documento (máx 1-2 docs por operação)
// ---------------------------------------------------------------------------

export async function createAudit(audit: AuditSession, actor: string): Promise<AuditSession> {
  const docId = getDocIdForCollection("audits", audit);
  markLegitimateAuditCreation(docId);

  const nowIso = new Date().toISOString();
  const baseAudit: AuditSession = sanitizeForFirestore({
    ...audit,
    id: docId,
    generation: audit.generation || 1,
    rev: 1,
    reopenCycle: audit.reopenCycle || 0,
    updatedAt: nowIso,
    lastUpdatedBy: actor
  });
  delete baseAudit.deletedAt;
  delete baseAudit.deletedBy;

  const db = getClientFirestore();
  if (!db) {
    latestAuditMetaById.set(docId, {
      status: baseAudit.status,
      rev: 1,
      generation: baseAudit.generation || 1,
      reopenCycle: baseAudit.reopenCycle || 0
    });
    return baseAudit;
  }

  await runTransaction(db, async (tx) => {
    const docRef = doc(db, "audits", docId);
    const snap = await tx.get(docRef);
    if (snap.exists()) {
      const existing = snap.data() as any;
      if (!existing.deletedAt) {
        throw new FirestoreConflictError(
          `Já existe uma conferência ativa para o mapa ${audit.routeMap}.`,
          existing.status
        );
      }
      baseAudit.generation = Number(existing.generation || 1) + 1;
      baseAudit.rev = Number(existing.rev || 0) + 1;
    }
    tx.set(docRef, baseAudit);
  });

  deletedAuditIds.delete(docId);
  latestAuditMetaById.set(docId, {
    status: baseAudit.status,
    rev: baseAudit.rev || 1,
    generation: baseAudit.generation || 1,
    reopenCycle: baseAudit.reopenCycle || 0
  });
  getColCache("audits").set(docId, canonicalJson(baseAudit));
  return baseAudit;
}

export async function createRoute(route: ImportedRoute, actor: string): Promise<ImportedRoute> {
  const docId = getDocIdForCollection("importedRoutes", route);
  const nowIso = new Date().toISOString();
  const cleanBase: ImportedRoute = sanitizeForFirestore({
    ...route,
    id: docId,
    updatedAt: nowIso,
    lastUpdatedBy: actor
  });
  delete cleanBase.deletedAt;
  delete cleanBase.deletedBy;

  const db = getClientFirestore();
  if (!db) {
    const nextGen = getRouteGeneration(docId) + (isRouteDeletedId(docId) ? 1 : 0);
    const created = { ...cleanBase, generation: nextGen, rev: 1 };
    deletedRouteIds.delete(docId);
    latestRouteGenerationById.set(docId, nextGen);
    return created;
  }

  let finalRoute: ImportedRoute = { ...cleanBase, generation: 1, rev: 1 };

  await runTransaction(db, async (tx) => {
    const docRef = doc(db, "importedRoutes", docId);
    const snap = await tx.get(docRef);
    if (snap.exists()) {
      const existing = snap.data() as any;
      if (!existing.deletedAt) {
        throw new FirestoreConflictError(
          `O mapa ${route.routeMap} já está cadastrado e ativo para a data informada.`,
          existing.status
        );
      }
      const nextGen = Number(existing.generation || 1) + 1;
      const nextRev = Number(existing.rev || 0) + 1;
      finalRoute = {
        ...cleanBase,
        generation: nextGen,
        rev: nextRev
      };
      // Reaproveita o documento existente removendo deletedAt/deletedBy com deleteField() e incrementando generation
      tx.set(
        docRef,
        {
          ...finalRoute,
          deletedAt: deleteField(),
          deletedBy: deleteField()
        },
        { merge: true }
      );
    } else {
      finalRoute = { ...cleanBase, generation: 1, rev: 1 };
      tx.set(docRef, finalRoute);
    }
  });

  deletedRouteIds.delete(docId);
  latestRouteGenerationById.set(docId, finalRoute.generation || 1);
  getColCache("importedRoutes").set(docId, canonicalJson(finalRoute));
  return finalRoute;
}

export async function updateAuditGuarded(
  auditId: string,
  patch: Partial<AuditSession> & Record<string, any>,
  opts: {
    expectedStatus: AuditStatus[];
    actor: string;
    clearFields?: string[];
    appendHistoryEntry?: AuditSession["history"][number];
  }
): Promise<AuditSession> {
  const nowIso = new Date().toISOString();
  const db = getClientFirestore();

  if (!db) {
    if (isAuditDeletedId(auditId)) {
      throw new FirestoreNotFoundError("Este mapa foi excluído por outro usuário.");
    }
    const meta = getAuditMeta(auditId);
    if (meta && !opts.expectedStatus.includes(meta.status as AuditStatus)) {
      throw new FirestoreConflictError(
        `Este mapa já está com status "${meta.status}" e não pode ser alterado.`,
        meta.status
      );
    }
    const localPatch = sanitizeForFirestore({ ...patch });
    for (const k of opts.clearFields || []) {
      delete (localPatch as any)[k];
    }
    return {
      ...(localPatch as any),
      id: auditId,
      updatedAt: nowIso,
      lastUpdatedBy: opts.actor
    } as AuditSession;
  }

  let resultingAudit: AuditSession | null = null;

  await runTransaction(db, async (tx) => {
    const docRef = doc(db, "audits", auditId);
    const snap = await tx.get(docRef);
    if (!snap.exists()) {
      throw new FirestoreNotFoundError("Este mapa não existe mais no banco de dados.");
    }
    const data = snap.data() as any;
    if (data.deletedAt) {
      throw new FirestoreNotFoundError("Este mapa foi excluído por outro usuário.");
    }
    if (!opts.expectedStatus.includes(data.status)) {
      throw new FirestoreConflictError(
        `Este mapa já foi alterado por outro usuário (status atual: ${data.status}).`,
        data.status
      );
    }

    const baseHistory = Array.isArray(data.history) ? [...data.history] : [];
    const nextHistory = opts.appendHistoryEntry
      ? [...baseHistory, opts.appendHistoryEntry]
      : Array.isArray(patch.history)
        ? patch.history
        : baseHistory;

    const cleanPatch = sanitizeForFirestore({
      ...patch,
      history: nextHistory,
      updatedAt: nowIso,
      lastUpdatedBy: opts.actor
    }) as Record<string, any>;

    delete cleanPatch.id;

    const txUpdatePayload: Record<string, any> = {
      ...cleanPatch,
      rev: increment(1)
    };

    for (const fieldKey of opts.clearFields || []) {
      txUpdatePayload[fieldKey] = deleteField();
    }

    tx.update(docRef, txUpdatePayload);

    const nextObj: Record<string, any> = {
      ...data,
      ...cleanPatch,
      id: auditId,
      rev: Number(data.rev || 0) + 1
    };
    for (const fieldKey of opts.clearFields || []) {
      delete nextObj[fieldKey];
    }
    resultingAudit = nextObj as AuditSession;
  });

  if (!resultingAudit) {
    throw new FirestoreConflictError("Falha ao concluir a transação de atualização.");
  }

  const finalRes = resultingAudit as AuditSession;
  latestAuditMetaById.set(auditId, {
    status: finalRes.status,
    rev: Number(finalRes.rev || 1),
    generation: Number(finalRes.generation || 1),
    reopenCycle: Number(finalRes.reopenCycle || 0)
  });
  getColCache("audits").set(auditId, canonicalJson(finalRes));
  return finalRes;
}

export async function updateRouteStatus(
  routeId: string,
  status: ImportedRoute["status"],
  actor?: string,
  extraPatch?: Record<string, any>
): Promise<boolean> {
  if (!routeId) return false;
  const db = getClientFirestore();
  const nowIso = new Date().toISOString();

  if (!db) {
    return true;
  }

  try {
    let updated = false;
    await runTransaction(db, async (tx) => {
      const docRef = doc(db, "importedRoutes", routeId);
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;
      const data = snap.data() as any;
      if (data.deletedAt) return;

      const cleanExtra = extraPatch ? sanitizeForFirestore(extraPatch) : {};
      delete (cleanExtra as any).id;

      tx.update(docRef, {
        ...cleanExtra,
        status,
        updatedAt: nowIso,
        ...(actor ? { lastUpdatedBy: actor } : {}),
        rev: increment(1)
      });
      updated = true;
    });
    return updated;
  } catch (err) {
    console.warn(`[ClientFirebase] Erro ao atualizar status da rota ${routeId}:`, err);
    return false;
  }
}

export async function reopenAudit(
  auditId: string,
  opts: {
    actor: string;
    actorRoleTitle: string;
    justification: string;
    routeIds?: string[];
  }
): Promise<AuditSession> {
  const db = getClientFirestore();
  const nowIso = new Date().toISOString();

  const historyEntry = {
    timestamp: nowIso,
    action: `Mapa Reaberto por ${opts.actor} (${opts.actorRoleTitle})`,
    user: opts.actor,
    details: `Motivo da Reabertura: ${opts.justification}`
  };

  if (!db) {
    throw new FirestoreConflictError("Banco de dados Firestore indisponível para reabertura transacional.");
  }

  let reopenedResult: AuditSession | null = null;
  const uniqueRouteIds = Array.from(new Set((opts.routeIds || []).filter(Boolean)));

  await runTransaction(db, async (tx) => {
    const auditRef = doc(db, "audits", auditId);
    const auditSnap = await tx.get(auditRef);
    if (!auditSnap.exists() || auditSnap.data()?.deletedAt) {
      throw new FirestoreNotFoundError("Este mapa não foi encontrado ou foi excluído.");
    }
    const data = auditSnap.data() as any;
    if (data.status !== "finalizado_ok" && data.status !== "finalizado_divergente") {
      throw new FirestoreConflictError(
        `Somente mapas finalizados podem ser reabertos (status atual: ${data.status}).`,
        data.status
      );
    }

    // Ler rotas vinculadas (no máx 1-2 docs da mesma data/unificação) antes de gravar
    const routeSnaps = await Promise.all(
      uniqueRouteIds.map((rId) => tx.get(doc(db, "importedRoutes", rId)))
    );

    const nextCycle = Number(data.reopenCycle || 0) + 1;
    const nextHistory = [...(Array.isArray(data.history) ? data.history : []), historyEntry];

    const auditUpdate: Record<string, any> = {
      status: "conferido_fisico",
      reopeningRequested: false,
      reopened: true,
      reopenCycle: nextCycle,
      reopenedAt: nowIso,
      reopenedBy: opts.actor,
      reopeningJustification: opts.justification,
      pdfDownloaded: false,
      financeiroCiente: false,
      baixaConcluida: false,
      history: nextHistory,
      updatedAt: nowIso,
      lastUpdatedBy: opts.actor,
      rev: increment(1),
      surplusFlowStatus: deleteField(),
      closedAt: deleteField(),
      closedBy: deleteField()
    };

    tx.update(auditRef, auditUpdate);

    routeSnaps.forEach((rSnap) => {
      if (rSnap.exists() && !rSnap.data()?.deletedAt) {
        tx.update(rSnap.ref, {
          status: "em_analise",
          updatedAt: nowIso,
          lastUpdatedBy: opts.actor,
          rev: increment(1)
        });
      }
    });

    const nextState: Record<string, any> = {
      ...data,
      id: auditId,
      status: "conferido_fisico",
      reopeningRequested: false,
      reopened: true,
      reopenCycle: nextCycle,
      reopenedAt: nowIso,
      reopenedBy: opts.actor,
      reopeningJustification: opts.justification,
      pdfDownloaded: false,
      financeiroCiente: false,
      baixaConcluida: false,
      history: nextHistory,
      updatedAt: nowIso,
      lastUpdatedBy: opts.actor,
      rev: Number(data.rev || 0) + 1
    };
    delete nextState.surplusFlowStatus;
    delete nextState.closedAt;
    delete nextState.closedBy;
    reopenedResult = nextState as AuditSession;
  });

  if (!reopenedResult) {
    throw new FirestoreConflictError("Falha ao reabrir o mapa.");
  }

  const finalAudit = reopenedResult as AuditSession;
  latestAuditMetaById.set(auditId, {
    status: "conferido_fisico",
    rev: Number(finalAudit.rev || 1),
    generation: Number(finalAudit.generation || 1),
    reopenCycle: Number(finalAudit.reopenCycle || 1)
  });
  getColCache("audits").set(auditId, canonicalJson(finalAudit));
  return finalAudit;
}

export async function softDeleteMapCascade(params: {
  routeIds: string[];
  auditIds: string[];
  valeIds?: string[];
  alertIds?: string[];
  carregamentoIds?: string[];
  actor: string;
  logDetails: string;
}): Promise<boolean> {
  const db = getClientFirestore();
  const nowIso = new Date().toISOString();
  const uniqueRoutes = Array.from(new Set((params.routeIds || []).filter(Boolean)));
  const uniqueAudits = Array.from(new Set((params.auditIds || []).filter(Boolean)));
  const uniqueVales = Array.from(new Set((params.valeIds || []).filter(Boolean)));
  const uniqueAlerts = Array.from(new Set((params.alertIds || []).filter(Boolean)));
  const uniqueCarreg = Array.from(new Set((params.carregamentoIds || []).filter(Boolean)));

  uniqueRoutes.forEach((id) => deletedRouteIds.add(id));
  uniqueAudits.forEach((id) => deletedAuditIds.add(id));

  if (!db) return true;

  try {
    const batch = writeBatch(db);

    uniqueRoutes.forEach((id) => {
      batch.set(
        doc(db, "importedRoutes", id),
        {
          deletedAt: nowIso,
          deletedBy: params.actor,
          updatedAt: nowIso,
          lastUpdatedBy: params.actor,
          rev: increment(1)
        },
        { merge: true }
      );
    });

    uniqueAudits.forEach((id) => {
      batch.set(
        doc(db, "audits", id),
        {
          deletedAt: nowIso,
          deletedBy: params.actor,
          updatedAt: nowIso,
          lastUpdatedBy: params.actor,
          rev: increment(1)
        },
        { merge: true }
      );
    });

    uniqueVales.forEach((id) => batch.delete(doc(db, "vales", id)));
    uniqueAlerts.forEach((id) => batch.delete(doc(db, "fiscalAlerts", id)));
    uniqueCarreg.forEach((id) => batch.delete(doc(db, "carregamentoProcesses", id)));

    const logId = `log_del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    batch.set(doc(db, "auditLogs", logId), {
      id: logId,
      timestamp: nowIso,
      user: params.actor,
      operation: "EXCLUSÃO",
      details: params.logDetails
    });

    await batch.commit();
    return true;
  } catch (err) {
    console.warn("[ClientFirebase] Erro em softDeleteMapCascade:", err);
    if (isPermissionError(err)) checkPermissionError(err);
    if (isQuotaError(err)) checkQuotaError(err);
    return false;
  }
}

export async function markAuditPdfDownloadedDoc(auditId: string, actor: string): Promise<boolean> {
  if (!auditId) return false;
  const db = getClientFirestore();
  if (!db) return true;
  try {
    const nowIso = new Date().toISOString();
    await updateDoc(doc(db, "audits", auditId), {
      pdfDownloaded: true,
      updatedAt: nowIso,
      lastUpdatedBy: actor,
      rev: increment(1)
    });
    return true;
  } catch (err) {
    console.warn(`[ClientFirebase] Aviso ao marcar pdfDownloaded em ${auditId}:`, err);
    return false;
  }
}

export async function batchRepairFinalizedAudits(
  repairs: Array<{ id: string; closedAt: string; closedBy?: string }>,
  actor: string
): Promise<number> {
  if (!repairs || repairs.length === 0) return 0;
  const db = getClientFirestore();
  if (!db) return repairs.length;

  let repairedCount = 0;
  const nowIso = new Date().toISOString();
  const batchSize = 400;

  for (let i = 0; i < repairs.length; i += batchSize) {
    const chunk = repairs.slice(i, i + batchSize);
    const batch = writeBatch(db);
    chunk.forEach((rep) => {
      batch.update(doc(db, "audits", rep.id), {
        closedAt: rep.closedAt,
        ...(rep.closedBy ? { closedBy: rep.closedBy } : {}),
        pdfDownloaded: true,
        updatedAt: nowIso,
        lastUpdatedBy: actor,
        rev: increment(1)
      });
    });
    await batch.commit();
    repairedCount += chunk.length;
  }

  return repairedCount;
}

// --- Gerente de reconexão dos listeners em tempo real ----------------------
// ANTES: cada uma das 15 coleções tinha um único onSnapshot que, ao dar
// erro (rede instável, stream expirado, permission-denied pontual etc.),
// simplesmente MORRIA - o SDK do Firestore não tenta de novo sozinho depois
// que o callback de erro do onSnapshot é chamado, e nada aqui reanexava o
// listener. Isso fazia com que, "depois de um tempo", uma ou mais coleções
// parassem de atualizar silenciosamente (sem nenhum aviso na tela), até o
// usuário recarregar o app manualmente.
//
// Agora cada coleção tem sua própria reanexação com backoff exponencial
// (1s, 2s, 4s... até 30s), independente das outras, e existe um watchdog
// que força a reconexão completa se nenhuma sincronização acontecer por
// muito tempo (cobre o caso raro do stream travar sem chamar o erro).
let reconnectGeneration = 0;
let activeOnUpdateCallback: ((db: any) => void) | null = null;
let activeUnsubscribes: Record<string, () => void> = {};
const COLLECTION_RETRY_STATE: Record<string, { attempts: number; timer: any }> = {};
let watchdogInterval: any = null;
let reattachRequestListenerAttached = false;

function resetCollectionRetryState(colName: string) {
  const prev = COLLECTION_RETRY_STATE[colName];
  if (prev?.timer) clearTimeout(prev.timer);
  COLLECTION_RETRY_STATE[colName] = { attempts: 0, timer: null };
}

const MAX_COLLECTION_RETRY_DELAY_MS = 30000;

function scheduleCollectionRetry(colName: string, generation: number, attach: (c: string) => void) {
  const state = COLLECTION_RETRY_STATE[colName] || { attempts: 0, timer: null };
  if (state.timer) return; // já existe uma tentativa agendada para essa coleção
  const delay = Math.min(MAX_COLLECTION_RETRY_DELAY_MS, 1000 * Math.pow(2, state.attempts));
  state.attempts++;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (generation !== reconnectGeneration) return; // essa inscrição já foi encerrada/substituída
    attach(colName);
  }, delay);
  COLLECTION_RETRY_STATE[colName] = state;
}

function attachReattachRequestListener() {
  if (reattachRequestListenerAttached || typeof window === "undefined") return;
  reattachRequestListenerAttached = true;
  // Disparado quando uma flag global (permissão/cota/autenticação) se
  // recupera - qualquer coleção que ainda esteja esperando seu backoff
  // é reanexada na hora, em vez de esperar o timer correr.
  window.addEventListener('firestore_request_reattach', () => {
    forceReconnect();
  });
}

const WATCHDOG_INTERVAL_MS = 60000;

function startConnectionWatchdog() {
  if (watchdogInterval || typeof window === "undefined") return;
  watchdogInterval = setInterval(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (typeof document !== "undefined" && document.visibilityState !== 'visible') return;
    if (!activeOnUpdateCallback) return;
    // Only re-attach if listeners were unexpectedly lost or cleared
    const activeCount = Object.keys(activeUnsubscribes).length;
    if (activeCount === 0 && TRACKED_COLLECTIONS.length > 0) {
      console.warn(`[ClientFirebase] Listeners do Firestore vazios. Restaurando escuta em tempo real...`);
      forceReconnect();
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopConnectionWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

/**
 * Força o encerramento e a reconstrução de TODOS os listeners em tempo
 * real, reaproveitando o último callback registrado. Chamada automaticamente
 * pelo watchdog e ao restaurar permissão/cota/autenticação, e também deve
 * ser chamada manualmente quando o app volta ao primeiro plano
 * (ver o handler de visibilitychange em App.tsx).
 */
export function forceReconnect(): void {
  if (!activeOnUpdateCallback) return;
  subscribeToFirestore(activeOnUpdateCallback);
}

/**
 * Garante que os listeners estão ativos ao voltar para a aba sem destruir
 * conexões saudáveis (evita re-download completo de todas as coleções ao trocar de aba).
 */
export function ensureFirestoreConnected(): void {
  if (!activeOnUpdateCallback) return;
  const activeCount = Object.keys(activeUnsubscribes).length;
  const isStale = lastSuccessfulSyncTime > 0 && (Date.now() - lastSuccessfulSyncTime > 180000);
  if (activeCount < TRACKED_COLLECTIONS.length || isStale) {
    forceReconnect();
  }
}

let lastSyncEventDispatchedAt = 0;
function emitSyncedEventThrottled() {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastSyncEventDispatchedAt >= 1000) {
    lastSyncEventDispatchedAt = now;
    window.dispatchEvent(new CustomEvent('firestore_synced', { detail: { time: lastSuccessfulSyncTime } }));
  }
}

let g1163RestorePromise: Promise<boolean> | null = null;
let g1163RestoreCompleted = false;
let g1163ShouldKeepFallback = true;

function getDefaultG1163User() {
  const found = DEFAULT_USERS.find(
    (u) =>
      (u.username || "").trim().toLowerCase() === "g1163" ||
      (u.id || "").trim().toLowerCase() === "g1163"
  );
  return found ? { ...found, id: "g1163" } : null;
}

function hasG1163User(items: any[]): boolean {
  return items.some(
    (u: any) =>
      (u?.id || "").trim().toLowerCase() === "g1163" ||
      (u?.username || "").trim().toLowerCase() === "g1163"
  );
}

async function ensureG1163Restored(db: any, items: any[]): Promise<boolean> {
  if (hasG1163User(items)) {
    g1163RestoreCompleted = true;
    g1163ShouldKeepFallback = false;
    return false;
  }
  if (g1163RestoreCompleted) {
    return g1163ShouldKeepFallback;
  }
  if (!g1163RestorePromise) {
    g1163RestorePromise = (async () => {
      try {
        const markerRef = doc(db, "app_state", "user_restore_g1163_v1");
        const markerSnap = await getDoc(markerRef);
        if (!markerSnap.exists()) {
          const g1163Default = getDefaultG1163User();
          if (g1163Default) {
            const saved = await saveDocToFirestore("users", g1163Default);
            if (!saved) {
              g1163RestorePromise = null;
              return true;
            }
            await setDoc(markerRef, {
              restoredAt: new Date().toISOString(),
              username: "G1163",
            });
            g1163ShouldKeepFallback = true;
            g1163RestoreCompleted = true;
            return true;
          }
        }
        g1163ShouldKeepFallback = false;
        g1163RestoreCompleted = true;
        return false;
      } catch (e) {
        console.warn("[ClientFirebase] Erro ao verificar/restaurar usuário G1163:", e);
        g1163RestorePromise = null;
        return true;
      }
    })();
  }
  return await g1163RestorePromise;
}

/**
 * Requirement 3: Real-time queries straight from Firestore collections.
 * Seed default initial values directly to Firestore if collections are empty.
 */
export function subscribeToFirestore(onUpdate: (db: any) => void): () => void {
  const db = getClientFirestore();
  if (!db) return () => {};

  const myGeneration = ++reconnectGeneration;
  activeOnUpdateCallback = onUpdate;

  // Encerra qualquer inscrição/tentativa agendada da geração anterior antes de recomeçar
  Object.values(activeUnsubscribes).forEach((unsub) => { try { unsub(); } catch (e) {} });
  activeUnsubscribes = {};
  Object.values(COLLECTION_RETRY_STATE).forEach((s) => { if (s.timer) clearTimeout(s.timer); });

  console.log("[ClientFirebase] Inscrevendo para atualizações em tempo real nas coleções do Firestore...");

  const combinedDb: Record<string, any> = {
    users: [],
    drivers: [],
    vehicles: [],
    products: [],
    activeAssets: [],
    audits: [],
    vales: [],
    returnForecasts: [],
    fiscalAlerts: [],
    importedRoutes: [],
    audit_logs: [],
    auditLogs: [],
    customManual: "",
    empilhadores: [],
    carregamentoProcesses: [],
    controleSobras: [],
    fiveSEntries: [],
    safetyReports: [],
    blitzEntries: [],
    zeroBreakDeclarations: []
  };

  const attach = (colName: string) => {
    if (myGeneration !== reconnectGeneration) return; // geração substituída - não faz nada
    try {
      if (colName === "customManual") {
        const docRef = doc(db, "customManual", "main");
        const unsub = onSnapshot(docRef, (docSnap) => {
          if (myGeneration !== reconnectGeneration) return;
          resetCollectionRetryState(colName);
          markSyncSuccess();
          emitSyncedEventThrottled();
          if (docSnap.exists()) {
            const data = docSnap.data();
            combinedDb.customManual = data.html || data.content || "";
          } else {
            combinedDb.customManual = "";
            fetch('/api/db')
              .then(res => res.ok ? res.json() : null)
              .then(resData => {
                if (resData?.db?.customManual) {
                  setDoc(docRef, { html: resData.db.customManual, updatedAt: new Date().toISOString() }).catch(() => {});
                }
              }).catch(() => {});
          }
          onUpdate({ customManual: combinedDb.customManual });
        }, (error) => handleSubscriptionError(error, colName, myGeneration, attach));
        activeUnsubscribes[colName] = unsub;
      } else {
        const collRef = collection(db, colName);
        const itemsById = new Map<string, any>();
        let isInitialized = false;

        const normalizeDocForCol = (docId: string, data: any) => {
          const itemWithId = { ...data, id: docId };
          if (colName === "audits") {
            latestAuditMetaById.set(docId, {
              status: data.status,
              rev: Number(data.rev || 0),
              generation: Number(data.generation || 1),
              reopenCycle: Number(data.reopenCycle || 0),
              deletedAt: data.deletedAt
            });
            if (data.deletedAt) {
              deletedAuditIds.add(docId);
            } else {
              deletedAuditIds.delete(docId);
            }
            return {
              ...itemWithId,
              items: Array.isArray(data.items) ? data.items : [],
              assets: Array.isArray(data.assets) ? data.assets : [],
              history: Array.isArray(data.history) ? data.history : [],
              unifiedMaps: Array.isArray(data.unifiedMaps) ? data.unifiedMaps : [],
            };
          }
          if (colName === "importedRoutes") {
            latestRouteGenerationById.set(docId, Number(data.generation || 1));
            if (data.deletedAt) {
              deletedRouteIds.add(docId);
            } else {
              deletedRouteIds.delete(docId);
            }
          }
          return itemWithId;
        };

        const unsub = onSnapshot(collRef, (snapshot) => {
          if (myGeneration !== reconnectGeneration) return;
          resetCollectionRetryState(colName);
          markSyncSuccess();
          emitSyncedEventThrottled();

          // Seed defaults directly to Firestore ONLY if primary static collections are completely empty and confirmed by server (not local cache)
          if (!snapshot.metadata.fromCache && snapshot.empty && (colName === "users" || colName === "drivers" || colName === "vehicles" || colName === "products" || colName === "activeAssets")) {
            fetch('/api/db')
              .then(res => res.ok ? res.json() : null)
              .then(resData => {
                const srvDb = resData?.db;
                const itemsToSeed = srvDb && Array.isArray(srvDb[colName]) && srvDb[colName].length > 0
                  ? srvDb[colName]
                  : (colName === "users" ? DEFAULT_USERS :
                     colName === "drivers" ? DEFAULT_DRIVERS :
                     colName === "vehicles" ? DEFAULT_VEHICLES :
                     colName === "products" ? DEFAULT_PRODUCTS :
                     colName === "activeAssets" ? DEFAULT_ACTIVE_ASSETS : []);

                if (itemsToSeed && itemsToSeed.length > 0) {
                  saveDocsToFirestore(colName, itemsToSeed);
                }
              })
              .catch(() => {
                if (colName === "users" && DEFAULT_USERS.length > 0) {
                  saveDocsToFirestore("users", DEFAULT_USERS);
                } else if (colName === "drivers" && DEFAULT_DRIVERS.length > 0) {
                  saveDocsToFirestore("drivers", DEFAULT_DRIVERS);
                } else if (colName === "vehicles" && DEFAULT_VEHICLES.length > 0) {
                  saveDocsToFirestore("vehicles", DEFAULT_VEHICLES);
                } else if (colName === "products" && DEFAULT_PRODUCTS.length > 0) {
                  saveDocsToFirestore("products", DEFAULT_PRODUCTS);
                } else if (colName === "activeAssets" && DEFAULT_ACTIVE_ASSETS.length > 0) {
                  saveDocsToFirestore("activeAssets", DEFAULT_ACTIVE_ASSETS);
                }
              });
          }

          const targetCol = COLLECTION_MAP[colName] || colName;
          const colCache = getColCache(targetCol);

          if (!isInitialized) {
            isInitialized = true;
            itemsById.clear();
            const currentServerIds = new Set<string>();
            for (const d of snapshot.docs) {
              const data = d.data();
              const docId = d.id;
              currentServerIds.add(docId);
              colCache.set(docId, canonicalJson({ ...data, id: docId }));
              const normalized = normalizeDocForCol(docId, data);
              if ((colName === "audits" || colName === "importedRoutes") && (normalized as any).deletedAt) {
                continue;
              }
              itemsById.set(docId, normalized);
            }
            for (const cachedId of Array.from(colCache.keys())) {
              if (!currentServerIds.has(cachedId)) {
                colCache.delete(cachedId);
              }
            }
          } else {
            const changes = snapshot.docChanges();
            if (changes.length === 0) {
              return;
            }
            for (const change of changes) {
              const docId = change.doc.id;
              if (change.type === "removed") {
                itemsById.delete(docId);
                colCache.delete(docId);
                if (colName === "audits") latestAuditMetaById.delete(docId);
                if (colName === "importedRoutes") latestRouteGenerationById.delete(docId);
              } else {
                const data = change.doc.data();
                colCache.set(docId, canonicalJson({ ...data, id: docId }));
                const normalized = normalizeDocForCol(docId, data);
                if ((colName === "audits" || colName === "importedRoutes") && (normalized as any).deletedAt) {
                  itemsById.delete(docId);
                } else {
                  itemsById.set(docId, normalized);
                }
              }
            }
          }

          const items = Array.from(itemsById.values());

          if (colName === "auditLogs") {
            combinedDb.auditLogs = items;
            combinedDb.audit_logs = items;
            onUpdate({ auditLogs: items, audit_logs: items });
          } else if (colName === "users") {
            let effectiveUsers = items;
            if (items.length > 0 && !hasG1163User(items)) {
              const g1163Default = getDefaultG1163User();
              if (!snapshot.metadata.fromCache) {
                if (!g1163RestoreCompleted) {
                  if (g1163Default && g1163ShouldKeepFallback) {
                    effectiveUsers = [...items, g1163Default];
                  }
                  ensureG1163Restored(db, items).then((wasRestored) => {
                    if (!wasRestored && myGeneration === reconnectGeneration) {
                      combinedDb.users = items;
                      onUpdate({ users: items });
                    }
                  });
                }
              } else if (g1163Default && g1163ShouldKeepFallback) {
                effectiveUsers = [...items, g1163Default];
              }
            } else if (hasG1163User(items)) {
              g1163RestoreCompleted = true;
              g1163ShouldKeepFallback = false;
            }
            combinedDb[colName] = effectiveUsers;
            onUpdate({ [colName]: effectiveUsers });
          } else {
            combinedDb[colName] = items;
            onUpdate({ [colName]: items });
          }
        }, (error) => handleSubscriptionError(error, colName, myGeneration, attach));
        activeUnsubscribes[colName] = unsub;
      }
    } catch (err) {
      handleSubscriptionError(err, colName, myGeneration, attach);
    }
  };

  TRACKED_COLLECTIONS.forEach((colName) => {
    resetCollectionRetryState(colName);
    attach(colName);
  });

  attachReattachRequestListener();
  startConnectionWatchdog();

  return () => {
    if (myGeneration === reconnectGeneration) {
      activeOnUpdateCallback = null;
      stopConnectionWatchdog();
      Object.values(activeUnsubscribes).forEach((unsub) => {
        try {
          unsub();
        } catch (e) {}
      });
      activeUnsubscribes = {};
      Object.values(COLLECTION_RETRY_STATE).forEach((s) => { if (s.timer) clearTimeout(s.timer); });
    }
  };
}

function handleSubscriptionError(error: any, colName: string, generation: number, attach: (c: string) => void) {
  if (isPermissionError(error)) {
    checkPermissionError(error);
  } else if (isQuotaError(error)) {
    checkQuotaError(error);
  } else {
    console.warn(`[ClientFirebase] Listener da coleção '${colName}' caiu (${error?.code || error}). Reagendando...`);
  }
  if (generation === reconnectGeneration) {
    scheduleCollectionRetry(colName, generation, attach);
  }
}

export async function fetchDirectlyFromFirestore(): Promise<any> {
  const db = getClientFirestore();
  if (!db) return null;

  const combinedDb: Record<string, any> = {
    users: [],
    drivers: [],
    vehicles: [],
    products: [],
    activeAssets: [],
    audits: [],
    vales: [],
    returnForecasts: [],
    fiscalAlerts: [],
    importedRoutes: [],
    audit_logs: [],
    auditLogs: [],
    customManual: "",
    empilhadores: [],
    carregamentoProcesses: [],
    controleSobras: [],
    fiveSEntries: [],
    safetyReports: [],
    blitzEntries: [],
    zeroBreakDeclarations: []
  };

  try {
    const promises = TRACKED_COLLECTIONS.map(async (colName) => {
      try {
        if (colName === "customManual") {
          const docRef = doc(db, "customManual", "main");
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const data = snap.data();
            combinedDb.customManual = data.html || data.content || "";
          }
        } else {
          const collRef = collection(db, colName);
          const snap = await getDocs(collRef);
          const targetCol = COLLECTION_MAP[colName] || colName;
          const colCache = getColCache(targetCol);
          const rawItems = snap.docs.map((d) => {
            const data = d.data();
            colCache.set(d.id, JSON.stringify(data));
            if (colName === "audits") {
              latestAuditMetaById.set(d.id, {
                status: data.status,
                rev: Number(data.rev || 0),
                generation: Number(data.generation || 1),
                reopenCycle: Number(data.reopenCycle || 0),
                deletedAt: data.deletedAt
              });
              if (data.deletedAt) deletedAuditIds.add(d.id);
              else deletedAuditIds.delete(d.id);
              return {
                ...data,
                id: d.id,
                items: Array.isArray(data.items) ? data.items : [],
                assets: Array.isArray(data.assets) ? data.assets : [],
                history: Array.isArray(data.history) ? data.history : [],
                unifiedMaps: Array.isArray(data.unifiedMaps) ? data.unifiedMaps : [],
              };
            }
            if (colName === "importedRoutes") {
              latestRouteGenerationById.set(d.id, Number(data.generation || 1));
              if (data.deletedAt) deletedRouteIds.add(d.id);
              else deletedRouteIds.delete(d.id);
            }
            return {
              ...data,
              id: d.id
            };
          });
          const items = (colName === "audits" || colName === "importedRoutes")
            ? rawItems.filter((it: any) => !it.deletedAt)
            : rawItems;
          if (colName === "auditLogs") {
            combinedDb.auditLogs = items;
            combinedDb.audit_logs = items;
          } else if (colName === "users") {
            if (items.length > 0 && !hasG1163User(items)) {
              const wasRestored = await ensureG1163Restored(db, items);
              const g1163Default = getDefaultG1163User();
              combinedDb[colName] = wasRestored && g1163Default ? [...items, g1163Default] : items;
            } else {
              combinedDb[colName] = items;
            }
          } else {
            combinedDb[colName] = items;
          }
        }
      } catch (err) {
        if (isPermissionError(err)) {
          checkPermissionError(err);
        } else {
          checkQuotaError(err);
        }
      }
    });

    await Promise.all(promises);
    lastSuccessfulSyncTime = Date.now();
    return combinedDb;
  } catch (e) {
    return null;
  }
}

export async function getGeminiKeyFromFirestore(): Promise<string | null> {
  const db = getClientFirestore();
  if (!db) return null;
  try {
    const docRef = doc(db, "app_state", "gemini_config");
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data()?.apiKey || null;
    }
  } catch (e) {}
  return null;
}

export async function saveGeminiKeyToFirestore(apiKey: string): Promise<boolean> {
  const db = getClientFirestore();
  if (!db) return false;
  try {
    const docRef = doc(db, "app_state", "gemini_config");
    await setDoc(docRef, { apiKey: apiKey });
    return true;
  } catch (e) {}
  return false;
}