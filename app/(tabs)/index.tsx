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

function lastVoteKey(borderId: string, dir: Dir) {
  return `kolonakufiri_lastvote_${sanitizeKey(borderId)}_${dir}`;
}

async function getLastVoteMs(borderId: string, dir: Dir): Promise<number> {
  const key = lastVoteKey(borderId, dir);
  if (Platform.OS === "web") {
    const v = globalThis?.localStorage?.getItem(key);
    return v ? Number(v) : 0;
  }
  const v = await SecureStore.getItemAsync(key);
  return v ? Number(v) : 0;
}

async function setLastVoteMs(borderId: string, dir: Dir, ms: number): Promise<void> {
  const key = lastVoteKey(borderId, dir);
  if (Platform.OS === "web") {
    globalThis?.localStorage?.setItem(key, String(ms));
    return;
  }
  await SecureStore.setItemAsync(key, String(ms));
}

/* ===== FLAGS (ONLY FOR KS / NMKD / ALB) ===== */

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

function parseHint(hint?: string) {
  const parts = (hint || "").split("↔").map((s) => s.trim());
  const left = parts[0] || "LEFT";
  const right = parts[1] || "RIGHT";
  return { left, right };
}

function dirLabel(border: Border, dir: Dir) {
  const { left, right } = parseHint(border.hint);
  return dir === "L2R" ? `${left} → ${right}` : `${right} → ${left}`;
}

function startOfDayMsLocal(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ================= LIVE STATUS CALC ================= */

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

/* ================= DAILY SUMMARY (PA GRAF) ================= */

function summarizeDay(reports: Report[], dir: Dir) {
  const counts = [0, 0, 0, 0];
  let sum = 0;
  let total = 0;

  for (const r of reports) {
    const rdir: Dir = r.dir === "R2L" ? "R2L" : "L2R";
    if (rdir !== dir) continue;

    const lvl = clamp(r.waitLevel ?? 0, 0, 3);
    counts[lvl] += 1;
    sum += lvl;
    total += 1;
  }

  const avg = total ? sum / total : 0;
  return { total, avg, counts };
}

/* ================= SCREEN ================= */

export default function HomeScreen() {
  const [selected, setSelected] = useState<Border>(BORDERS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const [dir, setDir] = useState<Dir>("L2R");
  const [reportsToday, setReportsToday] = useState<Report[]>([]);

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

  const liveReports = useMemo(() => {
    void liveTick;
    const since = Date.now() - LIVE_WINDOW_MS;
    return reportsToday.filter((r) => r.createdAtMs >= since);
  }, [reportsToday, liveTick]);

  const live = useMemo(() => computeSmartLevel(liveReports), [liveReports]);
  const status = statusFromLevel(live.level);

  const daySummary = useMemo(() => summarizeDay(reportsToday, dir), [reportsToday, dir]);

  async function submit(waitLevel: number) {
    if (submitting) return;

    if (!deviceId) {
      Alert.alert("Prit pak…", "App-i po pregadit device ID.");
      return;
    }

    setSubmitting(true);
    try {
      const lastMs = await getLastVoteMs(selected.id, dir);
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
        dir,
        createdAtMs: now,
        createdAt: serverTimestamp(),
      });

      await setLastVoteMs(selected.id, dir, now);
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
                onPress={() => {
                  setSelected(item);
                  setDir("L2R");
                }}
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

        {/* ✅ Home = pa graf: veç karta */}
        <View style={styles.card}>
          <Text style={styles.blockTitle}>LIVE (reset çdo {LIVE_WINDOW_HOURS}h)</Text>
          <Text style={styles.live}>
            {status.emoji} {status.title}
          </Text>
          <Text style={styles.desc}>{status.desc}</Text>

          <Text style={styles.meta}>
            {live.count} raporte (2h) • Confidence: {live.confidence}
          </Text>

          <Text style={styles.breakdown}>
            🟢 {Math.round(live.buckets[1])} | 🟡 {Math.round(live.buckets[2])} | 🔴{" "}
            {Math.round(live.buckets[3])}
          </Text>

          <View style={styles.sep} />

          <Text style={styles.blockTitle}>SOT (për këtë kufi)</Text>

          <View style={styles.dirRow}>
            <Pressable
              onPress={() => setDir("L2R")}
              style={[styles.dirBtn, dir === "L2R" && styles.dirBtnActive]}
            >
              <Text style={[styles.dirText, dir === "L2R" && styles.dirTextActive]}>
                {dirLabel(selected, "L2R")}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setDir("R2L")}
              style={[styles.dirBtn, dir === "R2L" && styles.dirBtnActive]}
            >
              <Text style={[styles.dirText, dir === "R2L" && styles.dirTextActive]}>
                {dirLabel(selected, "R2L")}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.meta}>
            Total: <Text style={styles.metaStrong}>{daySummary.total}</Text> raporte
          </Text>
          <Text style={styles.meta}>
            Mesatarja:{" "}
            <Text style={styles.metaStrong}>{daySummary.avg.toFixed(2)}</Text>
          </Text>
          <Text style={styles.breakdown}>
            ✅ {daySummary.counts[0]} | 🟢 {daySummary.counts[1]} | 🟡{" "}
            {daySummary.counts[2]} | 🔴 {daySummary.counts[3]}
          </Text>

          <Text style={styles.cooldownNote}>
            TEST Limit: 1 votë / 1 minutë / për device (për këtë kufi + këtë anë)
          </Text>
        </View>

        <Text style={styles.section}>Raporto gjendjen</Text>

        <Pressable
          style={[styles.bigBtn, disabled && styles.disabled]}
          onPress={() => submit(0)}
        >
          <Text style={styles.bigBtnText}>A ka kolonë ?</Text>
        </Pressable>

        <View style={styles.row}>
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

  blockTitle: { color: TEXT, fontWeight: "900", marginBottom: 6 },
  live: { fontSize: 24, fontWeight: "900", color: TEXT },
  desc: { color: MUTED, marginTop: 6 },
  meta: { color: MUTED, marginTop: 8, fontSize: 12, lineHeight: 18 },
  metaStrong: { color: TEXT, fontWeight: "900" },
  breakdown: { color: MUTED, marginTop: 8, fontSize: 12 },
  cooldownNote: { color: MUTED, marginTop: 10, fontSize: 12, lineHeight: 18 },

  sep: { height: 1, backgroundColor: BORDER, marginVertical: 12, opacity: 0.9 },

  section: { color: TEXT, fontWeight: "800", marginTop: 10 },

  dirRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  dirBtn: {
    flex: 1,
    backgroundColor: "#0e141c",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  dirBtnActive: { backgroundColor: "#fff", borderColor: "#fff" },
  dirText: { color: TEXT, fontWeight: "900", fontSize: 12 },
  dirTextActive: { color: "#000" },

  bigBtn: {
    backgroundColor: "#10261b",
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: "center",
  },
  bigBtnText: { color: TEXT, fontWeight: "900", fontSize: 16 },

  row: { flexDirection: "row", gap: 10 },
  smallBtn: {
    flex: 1,
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
