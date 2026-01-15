import * as Random from "expo-random";
import * as SecureStore from "expo-secure-store";
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { db } from "../../src/firebase";

/* ================= TYPES ================= */

type Border = {
  id: string;
  name: string;
  hint?: string; // "KS ↔ NMKD"
};

type Dir = "L2R" | "R2L";

type Report = {
  borderId: string;
  waitLevel: number; // 0..3
  createdAtMs: number;
  deviceId?: string;
  dir?: Dir;
};

type ApiTraffic = {
  status: "FREE" | "MEDIUM" | "HEAVY" | "UNKNOWN";
  label: string;
  updatedAtMs: number;
  cached?: boolean;
  ratio?: number | null; // currentSpeed/freeFlowSpeed
  currentSpeed?: number | null;
  freeFlowSpeed?: number | null;
};

/* ================= DATA ================= */

const BORDERS: Border[] = [
  { id: "HANI_I_ELEZIT", name: "Bllacë (Hani i Elezit)", hint: "KS ↔ NMKD" },
  { id: "Vërmicë", name: "Vërmicë", hint: "KS ↔ ALB" },
  { id: "JARINJE", name: "Jarinjë", hint: "KS ↔ S" },
];

// ✅ LIVE reset çdo 2 orë
const LIVE_WINDOW_HOURS = 2;
const LIVE_WINDOW_MS = LIVE_WINDOW_HOURS * 60 * 60 * 1000;

// ✅ TEST: 1 minut cooldown
const VOTE_COOLDOWN_MS = 60 * 1000;
const DEVICE_KEY = "kolonakufiri_device_id";

/* ================= TOMTOM (DIRECT) SETTINGS ================= */

// ✅ VENDOSE KEY KETU (për MVP)
// ⚠️ Mos e shty në GitHub. Kur ta bësh prodhim, e kalon në server/worker.
const TOMTOM_KEY = "CggQRwzwUoVB0QXQeuP1FrV5MksVBerA";

// ✅ Pikat te segmenti i Hanit të Elezit (approx është OK)
const HAN_ELEZI_POINTS = [
  { lat: 42.1569, lon: 21.3051 }, // para kufirit (KS)
  { lat: 42.1584, lon: 21.2990 }, // te terminali
  { lat: 42.1602, lon: 21.2928 }, // pas kufirit (NMKD)
];

// ✅ Cache lokal (mos e harxho limitin)
const API_CACHE_MS = 90 * 1000;

/* ================= HELPERS ================= */

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function statusFromLevel(level: number) {
  if (level === 0)
    return { title: "E lirë", emoji: "✅", desc: "S’ka kolonë / shumë pak" };
  if (level === 1) return { title: "E vogël", emoji: "🟢", desc: "Pak pritje" };
  if (level === 2)
    return { title: "Mesatare", emoji: "🟡", desc: "Pritje normale" };
  return { title: "E ngarkuar", emoji: "🔴", desc: "Pritje e gjatë" };
}

// Ratio -> status (3 nivele)
function apiStatusFromRatio(ratio: number): ApiTraffic["status"] {
  if (!Number.isFinite(ratio)) return "UNKNOWN";
  if (ratio >= 0.8) return "FREE";
  if (ratio >= 0.5) return "MEDIUM";
  return "HEAVY";
}

function apiLabelFromStatus(status: ApiTraffic["status"]) {
  if (status === "FREE") return "E lirë";
  if (status === "MEDIUM") return "Mesatare";
  if (status === "HEAVY") return "E ngarkuar";
  return "N/A";
}

// Mapping API -> level (0..3)
function levelFromApiStatus(s: ApiTraffic["status"]): number {
  if (s === "FREE") return 0;
  if (s === "MEDIUM") return 2; // 🟡 Mesatare
  if (s === "HEAVY") return 3; // 🔴 E ngarkuar
  return 0;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getOrCreateDeviceId(): Promise<string> {
  if (Platform.OS === "web") {
    const existing = globalThis?.localStorage?.getItem(DEVICE_KEY);
    if (existing) return existing;

    const arr = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
    else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);

    const id = bytesToHex(arr);
    globalThis?.localStorage?.setItem(DEVICE_KEY, id);
    return id;
  }

  const existing = await SecureStore.getItemAsync(DEVICE_KEY);
  if (existing) return existing;

  const bytes = Random.getRandomBytes(16);
  const id = bytesToHex(bytes);

  await SecureStore.setItemAsync(DEVICE_KEY, id);
  return id;
}

function sanitizeKey(input: string) {
  return input.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");
}

function lastVoteKey(borderId: string) {
  return `kolonakufiri_lastvote_${sanitizeKey(borderId)}`;
}

async function getLastVoteMs(borderId: string): Promise<number> {
  const key = lastVoteKey(borderId);
  if (Platform.OS === "web") {
    const v = globalThis?.localStorage?.getItem(key);
    return v ? Number(v) : 0;
  }
  const v = await SecureStore.getItemAsync(key);
  return v ? Number(v) : 0;
}

async function setLastVoteMs(borderId: string, ms: number): Promise<void> {
  const key = lastVoteKey(borderId);
  if (Platform.OS === "web") {
    globalThis?.localStorage?.setItem(key, String(ms));
    return;
  }
  await SecureStore.setItemAsync(key, String(ms));
}

function lastVoteLevelKey(borderId: string) {
  return `kolonakufiri_lastvote_level_${sanitizeKey(borderId)}`;
}

async function getLastVoteLevel(borderId: string): Promise<number | null> {
  const key = lastVoteLevelKey(borderId);
  if (Platform.OS === "web") {
    const v = globalThis?.localStorage?.getItem(key);
    return v === null ? null : Number(v);
  }
  const v = await SecureStore.getItemAsync(key);
  return v === null ? null : Number(v);
}

async function setLastVoteLevel(borderId: string, level: number): Promise<void> {
  const key = lastVoteLevelKey(borderId);
  if (Platform.OS === "web") {
    globalThis?.localStorage?.setItem(key, String(level));
    return;
  }
  await SecureStore.setItemAsync(key, String(level));
}

/* ===== FLAGS ===== */

function flagFor(code: string) {
  const c = code.toUpperCase();
  if (c === "KS") return require("../icons/kosovo.png");
  if (c === "NMKD") return require("../icons/macedonia.png");
  if (c === "ALB") return require("../icons/albania.png");
  return null;
}

function HintWithFlags({ hint, active }: { hint: string; active: boolean }) {
  const parts = hint.split("↔").map((s) => s.trim());
  const left = parts[0] || "";
  const right = parts[1] || "";

  const leftImg = flagFor(left);
  const rightImg = flagFor(right);

  return (
    <View style={styles.hintRow}>
      {leftImg ? (
        <Image source={leftImg} style={styles.flag} />
      ) : (
        <Text style={[styles.chipSub, active && styles.chipSubActive]}>{left}</Text>
      )}

      <Text style={[styles.hintArrow, active && styles.hintArrowActive]}>↔</Text>

      {rightImg ? (
        <Image source={rightImg} style={styles.flag} />
      ) : (
        <Text style={[styles.chipSub, active && styles.chipSubActive]}>{right}</Text>
      )}
    </View>
  );
}

function startOfDayMsLocal(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ================= LIVE STATUS CALC (VOTES) ================= */

function computeSmartLevel(reports: Report[]) {
  if (!reports.length) {
    return {
      level: 0,
      count: 0,
      confidence: "Low" as const,
      buckets: [0, 0, 0, 0],
      avg: 0,
    };
  }

  const now = Date.now();
  const buckets = [0, 0, 0, 0];

  for (const r of reports) {
    const minutes = Math.max(0, (now - r.createdAtMs) / 60000);
    const weight = Math.exp(-minutes / 12);
    const lvl = clamp(r.waitLevel ?? 0, 0, 3);
    buckets[lvl] += weight;
  }

  const wSum = buckets.reduce((a, b) => a + b, 0) || 1;
  const avg =
    (0 * buckets[0] + 1 * buckets[1] + 2 * buckets[2] + 3 * buckets[3]) / wSum;

  const idxs = [0, 1, 2, 3].sort((a, b) => buckets[b] - buckets[a]);
  const top1 = idxs[0];
  const top2 = idxs[1];

  const top1w = buckets[top1];
  const top2w = buckets[top2];

  const closeEnough = top2w >= top1w * 0.7;
  const farApart = Math.abs(top1 - top2) >= 2;

  let level = top1;

  if (farApart && closeEnough) {
    level = clamp(Math.round((top1 + top2) / 2), 0, 3);
  } else {
    if (Math.abs(avg - top1) < 0.35) level = top1;
    else level = clamp(Math.round(avg), 0, 3);
  }

  const count = reports.length;
  const confidence = count >= 10 ? "High" : count >= 4 ? "Medium" : "Low";

  return { level, count, confidence, buckets, avg };
}

/* ================= DAILY SUMMARY ================= */

function summarizeDayAllDirs(reports: Report[]) {
  const counts = [0, 0, 0, 0];
  let sum = 0;
  let total = 0;

  for (const r of reports) {
    const lvl = clamp(r.waitLevel ?? 0, 0, 3);
    counts[lvl] += 1;
    sum += lvl;
    total += 1;
  }

  const avg = total ? sum / total : 0;
  return { total, avg, counts };
}

function dayStatusFromAvg(avg: number) {
  const level = clamp(Math.round(avg), 0, 3);
  return statusFromLevel(level);
}

/* ================= TOMTOM FETCH (DIRECT) ================= */

let apiCache: { ts: number; data: ApiTraffic | null } = { ts: 0, data: null };

async function fetchTomTomFlow(lat: number, lon: number) {
  const url =
    `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
    `?point=${encodeURIComponent(`${lat},${lon}`)}` +
    `&unit=KMPH` +
    `&key=${encodeURIComponent(TOMTOM_KEY)}`;

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.description || json?.error || "TomTom error";
    throw new Error(msg);
  }
  return json;
}

async function getHanEleziTrafficDirect(): Promise<ApiTraffic> {
  const now = Date.now();
  if (apiCache.data && now - apiCache.ts < API_CACHE_MS) {
    return { ...apiCache.data, cached: true };
  }

  if (!TOMTOM_KEY || TOMTOM_KEY === "CggQRwzwUoVB0QXQeuP1FrV5MksVBerA") {
    throw new Error("Vendose TOMTOM_KEY në kod (për MVP).");
  }

  // Merr flow për secilën pikë, zgjedh “më të keqin” (min ratio)
  const results = await Promise.all(
    HAN_ELEZI_POINTS.map(async (p) => {
      const j = await fetchTomTomFlow(p.lat, p.lon);
      const d = j?.flowSegmentData || {};
      const currentSpeed = Number(d.currentSpeed);
      const freeFlowSpeed = Number(d.freeFlowSpeed);
      const ratio = freeFlowSpeed > 0 ? currentSpeed / freeFlowSpeed : NaN;
      return { currentSpeed, freeFlowSpeed, ratio };
    })
  );

  const worst = results
    .filter((r) => Number.isFinite(r.ratio))
    .sort((a, b) => a.ratio - b.ratio)[0];

  const ratio = worst?.ratio ?? NaN;
  const status = apiStatusFromRatio(ratio);
  const data: ApiTraffic = {
    status,
    label: apiLabelFromStatus(status),
    updatedAtMs: Date.now(),
    ratio: Number.isFinite(ratio) ? ratio : null,
    currentSpeed: worst?.currentSpeed ?? null,
    freeFlowSpeed: worst?.freeFlowSpeed ?? null,
    cached: false,
  };

  apiCache = { ts: now, data };
  return data;
}

/* ================= SCREEN ================= */

export default function HomeScreen() {
  const [selected, setSelected] = useState<Border>(BORDERS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const [reportsToday, setReportsToday] = useState<Report[]>([]);

  const [lastVoteLevel, setLastVoteLevelState] = useState<number | null>(null);

  // ✅ API traffic (direct) për Han i Elezit
  const [apiTraffic, setApiTraffic] = useState<ApiTraffic | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const isHanElezi = selected.id === "HANI_I_ELEZIT";

  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLiveTick((t) => t + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const id = await getOrCreateDeviceId();
        setDeviceId(id);
      } catch (e: any) {
        Alert.alert("Gabim", e?.message ?? "S’po mundem me kriju device ID.");
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const lvl = await getLastVoteLevel(selected.id);
        setLastVoteLevelState(
          typeof lvl === "number" && !Number.isNaN(lvl) ? clamp(lvl, 0, 3) : null
        );
      } catch {
        setLastVoteLevelState(null);
      }
    })();
  }, [selected.id]);

  useEffect(() => {
    const qy = query(collection(db, "reports"), where("borderId", "==", selected.id));

    const unsub = onSnapshot(qy, (snap) => {
      const start = startOfDayMsLocal(new Date());
      const all = snap.docs.map((d) => d.data() as Report);
      const today = all.filter(
        (r) => typeof r.createdAtMs === "number" && r.createdAtMs >= start
      );
      setReportsToday(today);
    });

    return () => unsub();
  }, [selected.id]);

  // ✅ DIRECT TomTom load (vetëm kur është Han i Elezit)
  useEffect(() => {
    let cancelled = false;

    async function loadApi() {
      if (!isHanElezi) {
        setApiTraffic(null);
        setApiError(null);
        setApiLoading(false);
        return;
      }

      setApiLoading(true);
      setApiError(null);
      try {
        const data = await getHanEleziTrafficDirect();
        if (!cancelled) setApiTraffic(data);
      } catch (e: any) {
        if (!cancelled) setApiError(e?.message ?? "S’po mundem me marrë trafikun.");
      } finally {
        if (!cancelled) setApiLoading(false);
      }
    }

    loadApi();
    const t = setInterval(loadApi, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [isHanElezi]);

  const liveReports = useMemo(() => {
    void liveTick;
    const since = Date.now() - LIVE_WINDOW_MS;
    return reportsToday.filter((r) => r.createdAtMs >= since);
  }, [reportsToday, liveTick]);

  const liveVotes = useMemo(() => computeSmartLevel(liveReports), [liveReports]);

  // ✅ LIVE level final: Han i Elezit -> API (nëse ka), përndryshe -> votat
  const liveLevel = useMemo(() => {
    if (isHanElezi && apiTraffic) return levelFromApiStatus(apiTraffic.status);
    return liveVotes.level;
  }, [isHanElezi, apiTraffic, liveVotes.level]);

  const status = useMemo(() => statusFromLevel(liveLevel), [liveLevel]);

  const daySummary = useMemo(() => summarizeDayAllDirs(reportsToday), [reportsToday]);
  const dayStatus = useMemo(() => dayStatusFromAvg(daySummary.avg), [daySummary.avg]);

  const lastVoteStatus = useMemo(() => {
    if (lastVoteLevel === null) return null;
    return statusFromLevel(clamp(lastVoteLevel, 0, 3));
  }, [lastVoteLevel]);

  async function submit(waitLevel: number) {
    if (submitting) return;

    if (!deviceId) {
      Alert.alert("Prit pak…", "App-i po pregadit device ID.");
      return;
    }

    setSubmitting(true);
    try {
      const lastMs = await getLastVoteMs(selected.id);
      const now = Date.now();

      if (lastMs && now - lastMs < VOTE_COOLDOWN_MS) {
        const secLeft = Math.ceil((VOTE_COOLDOWN_MS - (now - lastMs)) / 1000);
        Alert.alert("S’lejohet ende", `Provo prap pas ${secLeft} sekondash.`);
        return;
      }

      await addDoc(collection(db, "reports"), {
        borderId: selected.id,
        waitLevel,
        deviceId,
        createdAtMs: now,
        createdAt: serverTimestamp(),
      });

      await setLastVoteMs(selected.id, now);
      await setLastVoteLevel(selected.id, waitLevel);
      setLastVoteLevelState(waitLevel);
    } catch (e: any) {
      Alert.alert("Gabim", e?.message ?? "Ndodhi një gabim.");
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || deviceId === null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>KolonaKufiri</Text>
          <Text style={styles.subtitle}>Gjendja live e kolonave në kufi</Text>
        </View>

        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={BORDERS}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ gap: 10, marginBottom: 10 }}
          renderItem={({ item }) => {
            const active = item.id === selected.id;
            return (
              <Pressable
                onPress={() => setSelected(item)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipTitle, active && styles.chipTitleActive]}>
                  {item.name}
                </Text>

                {item.hint && <HintWithFlags hint={item.hint} active={active} />}
              </Pressable>
            );
          }}
        />

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.blockTitle}>LIVE (reset çdo {LIVE_WINDOW_HOURS}h)</Text>

            <View style={styles.lastVotePill}>
              <Text style={styles.lastVoteLabel}>Last vote:</Text>
              <Text style={styles.lastVoteValue}>
                {lastVoteStatus ? `${lastVoteStatus.emoji} ${lastVoteStatus.title}` : "—"}
              </Text>
            </View>
          </View>

          {isHanElezi ? (
            <View style={styles.apiBox}>
              <Text style={styles.apiTitle}>Traffic API (Han i Elezit)</Text>
              <Text style={styles.apiSub}>
                Pika reference: {HAN_ELEZI_POINTS.length} •{" "}
                {apiLoading ? "Duke lexu..." : apiTraffic ? "OK" : "N/A"}
              </Text>
              {apiError ? <Text style={styles.apiError}>⚠️ {apiError}</Text> : null}
              {apiTraffic ? (
                <Text style={styles.apiSub}>
                  Source: TomTom • Updated:{" "}
                  {new Date(apiTraffic.updatedAtMs).toLocaleTimeString()}
                  {apiTraffic.cached ? " (cache)" : ""}{" "}
                  {apiTraffic.ratio != null ? `• ratio: ${apiTraffic.ratio.toFixed(2)}` : ""}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.live}>
            {status.emoji} {status.title}
          </Text>
          <Text style={styles.desc}>{status.desc}</Text>

          <Text style={styles.meta}>
            {isHanElezi
              ? `Source: API${apiTraffic?.cached ? " (cache)" : ""}`
              : `${liveVotes.count} raporte (2h) • Confidence: ${liveVotes.confidence}`}
          </Text>

          {!isHanElezi ? (
            <Text style={styles.breakdown}>
              ✅ {Math.round(liveVotes.buckets[0])} | 🟢 {Math.round(liveVotes.buckets[1])} | 🟡{" "}
              {Math.round(liveVotes.buckets[2])} | 🔴 {Math.round(liveVotes.buckets[3])}
            </Text>
          ) : null}

          <View style={styles.sep} />

          <Text style={styles.blockTitle}>SOT (për këtë kufi)</Text>

          <Text style={styles.meta}>
            Total: <Text style={styles.metaStrong}>{daySummary.total}</Text> raporte
          </Text>

          <Text style={styles.meta}>
            Gjendja:{" "}
            <Text style={styles.metaStrong}>
              {dayStatus.emoji} {dayStatus.title}
            </Text>
          </Text>

          <Text style={styles.breakdown}>
            ✅ {daySummary.counts[0]} | 🟢 {daySummary.counts[1]} | 🟡{" "}
            {daySummary.counts[2]} | 🔴 {daySummary.counts[3]}
          </Text>

          <Text style={styles.cooldownNote}>
            TEST Limit: 1 votë / 1 minutë / për device (për këtë kufi)
          </Text>
        </View>

        <Text style={styles.section}>Raporto gjendjen</Text>

        <View style={styles.rowWrap}>
          <Pressable
            style={[styles.smallBtn, disabled && styles.disabled]}
            onPress={() => submit(0)}
          >
            <Text style={styles.smallBtnText}>✅ E lirë</Text>
          </Pressable>

          <Pressable
            style={[styles.smallBtn, disabled && styles.disabled]}
            onPress={() => submit(1)}
          >
            <Text style={styles.smallBtnText}>🟢 E vogël</Text>
          </Pressable>

          <Pressable
            style={[styles.smallBtn, disabled && styles.disabled]}
            onPress={() => submit(2)}
          >
            <Text style={styles.smallBtnText}>🟡 Mesatare</Text>
          </Pressable>

          <Pressable
            style={[styles.smallBtn, disabled && styles.disabled]}
            onPress={() => submit(3)}
          >
            <Text style={styles.smallBtnText}>🔴 E ngarkuar</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const BG = "#0b0f14";
const CARD = "#121a22";
const BORDER = "#263242";
const TEXT = "#e9eef5";
const MUTED = "#9fb0c3";

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  container: { padding: 16, gap: 14, paddingBottom: 24 },

  header: { marginBottom: 6 },
  title: { fontSize: 28, fontWeight: "900", color: TEXT },
  subtitle: { color: MUTED, fontWeight: "600", marginTop: 4 },

  chip: {
    backgroundColor: "#0e141c",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minWidth: 140,
  },
  chipActive: { backgroundColor: "#fff", borderColor: "#fff" },
  chipTitle: { color: TEXT, fontWeight: "900" },
  chipTitleActive: { color: "#000" },
  chipSub: { color: MUTED, fontSize: 11, marginTop: 4 },
  chipSubActive: { color: "#333" },

  hintRow: { marginTop: 6, flexDirection: "row", alignItems: "center", gap: 6 },
  flag: { width: 18, height: 12, borderRadius: 2, resizeMode: "cover" },
  hintArrow: { color: MUTED, fontSize: 11, fontWeight: "800" },
  hintArrowActive: { color: "#333" },

  card: {
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 20,
    padding: 16,
  },

  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  lastVotePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: "#0e141c",
  },
  lastVoteLabel: { color: MUTED, fontSize: 11, fontWeight: "800" },
  lastVoteValue: { color: TEXT, fontSize: 11, fontWeight: "900" },

  apiBox: {
    marginTop: 10,
    marginBottom: 8,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: "#0e141c",
  },
  apiTitle: { color: TEXT, fontWeight: "900", marginBottom: 4 },
  apiSub: { color: MUTED, fontSize: 12, lineHeight: 18 },
  apiError: { color: "#ffb3b3", fontSize: 12, marginTop: 6, fontWeight: "800" },

  blockTitle: { color: TEXT, fontWeight: "900", marginBottom: 6 },
  live: { fontSize: 24, fontWeight: "900", color: TEXT },
  desc: { color: MUTED, marginTop: 6 },
  meta: { color: MUTED, marginTop: 8, fontSize: 12, lineHeight: 18 },
  metaStrong: { color: TEXT, fontWeight: "900" },
  breakdown: { color: MUTED, marginTop: 8, fontSize: 12 },
  cooldownNote: { color: MUTED, marginTop: 10, fontSize: 12, lineHeight: 18 },

  sep: { height: 1, backgroundColor: BORDER, marginVertical: 12, opacity: 0.9 },

  section: { color: TEXT, fontWeight: "800", marginTop: 10 },

  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  smallBtn: {
    flexBasis: "48%",
    backgroundColor: "#0e141c",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
  },
  smallBtnText: { color: TEXT, fontWeight: "800" },

  disabled: { opacity: 0.55 },
});
