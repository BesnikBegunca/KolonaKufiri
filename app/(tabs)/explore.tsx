import { collection, onSnapshot, query, where } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Image,
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

type Border = { id: string; name: string; hint?: string };

type Report = {
  borderId: string;
  waitLevel: number; // 0..3
  createdAtMs: number;
  // dir e len si ekziston ne DB, po s’po e perdorim me butona
  dir?: "L2R" | "R2L";
};

/* ================= DATA ================= */

const BORDERS: Border[] = [
  { id: "HANI_I_ELEZIT", name: "Bllacë (Hani i Elezit)", hint: "KS ↔ NMKD" },
  { id: "Vërmicë", name: "Vërmicë", hint: "KS ↔ ALB" },
  { id: "JARINJE", name: "Jarinjë", hint: "KS ↔ S" },
];

// ✅ bucket çdo 15 min (krejt dita = 96 pika)
const LINE_BUCKET_MIN = 15;
const LINE_BUCKET_MS = LINE_BUCKET_MIN * 60 * 1000;
const LINE_POINTS = Math.floor((24 * 60) / LINE_BUCKET_MIN); // 96

/* ================= HELPERS ================= */

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function startOfDayMsLocal(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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

/* ================= STATUS ================= */

function statusFromLevel(level: number) {
  if (level <= 0) return { title: "E lirë", emoji: "✅" };
  if (level === 1) return { title: "E vogël", emoji: "🟢" };
  if (level === 2) return { title: "Mesatare", emoji: "🟡" };
  return { title: "E ngarkuar", emoji: "🔴" };
}

// ✅ mesatarja si fjale (jo 1.50)
function statusFromAvg(avg: number) {
  const a = clamp(avg, 0, 3);
  const lvl = a < 0.5 ? 0 : a < 1.5 ? 1 : a < 2.5 ? 2 : 3;
  return statusFromLevel(lvl);
}

/* ================= BUCKETS ================= */

type Bucket = { sum: number; count: number; avg: number };

function buildLineBuckets15minAll(reports: Report[], startDayMs: number) {
  const buckets: Bucket[] = Array.from({ length: LINE_POINTS }, () => ({
    sum: 0,
    count: 0,
    avg: 0,
  }));

  for (const r of reports) {
    if (typeof r.createdAtMs !== "number") continue;
    if (r.createdAtMs < startDayMs) continue;

    const idx = Math.floor((r.createdAtMs - startDayMs) / LINE_BUCKET_MS);
    if (idx < 0 || idx >= LINE_POINTS) continue;

    const lvl = clamp(r.waitLevel ?? 0, 0, 3);
    buckets[idx].sum += lvl;
    buckets[idx].count += 1;
  }

  for (let i = 0; i < LINE_POINTS; i++) {
    buckets[i].avg = buckets[i].count ? buckets[i].sum / buckets[i].count : 0;
  }

  // smooth lehtë (3-point moving average)
  return buckets.map((b, i) => {
    const a = buckets[i - 1]?.avg ?? b.avg;
    const c = buckets[i + 1]?.avg ?? b.avg;
    return { ...b, avg: (a + b.avg + c) / 3 };
  });
}

function summarizeDayAll(reports: Report[]) {
  const counts = [0, 0, 0, 0];
  let sum = 0;
  let total = 0;

  for (const r of reports) {
    const lvl = clamp(r.waitLevel ?? 0, 0, 3);
    counts[lvl] += 1;
    sum += lvl;
    total += 1;
  }

  return { total, avg: total ? sum / total : 0, counts };
}

/* ================= CHART (Crypto-like axis) ================= */

function yLabelFor(level: number) {
  if (level <= 0) return "E lirë";
  if (level === 1) return "E vogël";
  if (level === 2) return "Mesatare";
  return "E ngarkuar";
}

function CryptoLineChart({ buckets }: { buckets: Bucket[] }) {
  const H = 140;
  const step = 6;
  const W = (LINE_POINTS - 1) * step + 16;

  const points = buckets.map((b, i) => {
    const y01 = 1 - clamp(b.avg / 3, 0, 1);
    const y = Math.round(y01 * (H - 16)) + 8;
    const x = 8 + i * step;
    return { x, y, count: b.count };
  });

  const gridLevels = [0, 1, 2, 3].map((lvl) => {
    const y01 = 1 - lvl / 3;
    const y = Math.round(y01 * (H - 16)) + 8;
    return { lvl, y };
  });

  return (
    <View style={styles.chartWrap}>
      {/* LEFT AXIS */}
      <View style={[styles.axisLeft, { height: H }]}>
        {gridLevels.map((g) => (
          <View key={`ylab-${g.lvl}`} style={[styles.axisRow, { top: g.y - 8 }]}>
            <Text style={styles.axisText}>{yLabelFor(g.lvl)}</Text>
          </View>
        ))}
      </View>

      {/* RIGHT: CHART CANVAS (scrollable) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chartBlock}>
          <View style={[styles.lineCanvas, { height: H, width: W }]}>
            {/* grid lines */}
            {gridLevels.map((g) => (
              <View
                key={`grid-${g.lvl}`}
                style={[
                  styles.gridLine,
                  {
                    top: g.y,
                    opacity: g.lvl === 0 ? 0.35 : 0.25,
                  },
                ]}
              />
            ))}

            {/* segments */}
            {points.map((p, i) => {
              if (i === 0) return null;
              const prev = points[i - 1];
              const dx = p.x - prev.x;
              const dy = p.y - prev.y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

              return (
                <View
                  key={`seg-${i}`}
                  style={[
                    styles.lineSeg,
                    {
                      left: prev.x,
                      top: prev.y,
                      width: len,
                      opacity: prev.count || p.count ? 0.9 : 0.25,
                      transform: [{ rotate: `${angle}deg` }],
                    },
                  ]}
                />
              );
            })}

            {/* dots çdo 1 orë (4*15min) */}
            {points.map((p, i) => {
              if (i % 4 !== 0) return null;
              return (
                <View
                  key={`dot-${i}`}
                  style={[
                    styles.lineDot,
                    {
                      left: p.x - 3,
                      top: p.y - 3,
                      opacity: p.count ? 1 : 0.25,
                    },
                  ]}
                />
              );
            })}
          </View>

          <View style={[styles.chartMetaRow, { width: W }]}>
            <Text style={styles.chartMetaText}>00:00</Text>
            <Text style={styles.chartMetaText}>12:00</Text>
            <Text style={styles.chartMetaText}>24:00</Text>
          </View>

          <Text style={styles.chartLegend}>
            Y = gjendja (E lirë → E ngarkuar) • Line = mesatarja çdo {LINE_BUCKET_MIN}min
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

/* ================= SCREEN ================= */

export default function ExploreScreen() {
  const [selected, setSelected] = useState<Border>(BORDERS[0]);
  const [reportsToday, setReportsToday] = useState<Report[]>([]);

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

  const dayStart = useMemo(() => startOfDayMsLocal(new Date()), []);
  const buckets = useMemo(
    () => buildLineBuckets15minAll(reportsToday, dayStart),
    [reportsToday, dayStart]
  );

  const summary = useMemo(() => summarizeDayAll(reportsToday), [reportsToday]);
  const avgStatus = useMemo(() => statusFromAvg(summary.avg), [summary.avg]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Grafikoni</Text>
          <Text style={styles.subtitle}>Grafika ditore për kufijtë</Text>
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
          <Text style={styles.blockTitle}>{selected.name}</Text>

          {/* ✅ pa butona drejtimi + mesatarja si fjale */}
          <Text style={styles.meta}>
            Total: <Text style={styles.metaStrong}>{summary.total}</Text> • Mesatarja:{" "}
            <Text style={styles.metaStrong}>
              {avgStatus.emoji} {avgStatus.title}
            </Text>
          </Text>

          <Text style={styles.breakdown}>
            ✅ {summary.counts[0]} | 🟢 {summary.counts[1]} | 🟡 {summary.counts[2]} | 🔴{" "}
            {summary.counts[3]}
          </Text>

          <View style={styles.sep} />

          <Text style={styles.chartTitle}>Line chart (krejt dita)</Text>

          {/* ✅ Crypto-like chart */}
          <CryptoLineChart buckets={buckets} />
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
  meta: { color: MUTED, marginTop: 8, fontSize: 12, lineHeight: 18 },
  metaStrong: { color: TEXT, fontWeight: "900" },
  breakdown: { color: MUTED, marginTop: 8, fontSize: 12 },

  sep: { height: 1, backgroundColor: BORDER, marginVertical: 12, opacity: 0.9 },

  chartTitle: { color: TEXT, fontWeight: "900", marginBottom: 8 },

  /* ✅ chart layout */
  chartWrap: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  axisLeft: {
    width: 92,
    marginRight: 10,
    position: "relative",
  },
  axisRow: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 16,
    justifyContent: "center",
  },
  axisText: { color: MUTED, fontSize: 11, fontWeight: "800" },

  chartBlock: { marginTop: 0 },

  lineCanvas: {
    position: "relative",
    backgroundColor: "#0e141c",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 14,
    overflow: "hidden",
  },

  gridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "#cfd9e6",
  },

  lineSeg: {
    position: "absolute",
    height: 2,
    backgroundColor: "#cfd9e6",
    transformOrigin: "left center" as any,
  },
  lineDot: {
    position: "absolute",
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: "#ffffff",
  },

  chartMetaRow: {
    marginTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  chartMetaText: { color: MUTED, fontSize: 11 },
  chartLegend: { color: MUTED, fontSize: 11, marginTop: 6, lineHeight: 16 },
});
