"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileIconButton } from "@/components/ProfileIconButton";
import { getActiveUser, subscribeAuth, type SafeUser } from "@/lib/auth/auth";
import { persistSessionToStorage } from "@/lib/storage/history";
import {
  CLINICAL_DURATION_MS,
  QUICK_DURATION_MS,
  calculateAttentionBlocks,
  calculateClinicalStats,
  calculateCptMetrics,
  classifyResponse,
  createStructuredCptTrials,
  type CptEvent,
  type CptTrial,
} from "@/lib/cpt/engine";
import { ASRS_OPTIONS, ASRS_QUESTIONS, scoreAsrs, type AsrsResult } from "@/lib/cpt/asrs";
import {
  formatSubjectContextLabel,
  getDefaultTimeOfDay,
  type ScreenExposure,
  type SleepDuration,
  type SubjectContext,
  type TestMode,
} from "@/lib/cpt/context";
import { useGazeTracking } from "@/lib/gaze/tracking";
import type { GazeSample } from "@/lib/gaze/quality";
import { buildSessionExport } from "@/lib/export/session";
import { calculateTrialGdis, summarizeGdiResults } from "@/lib/cpt/engine";

type Phase = "questionnaire" | "ready" | "running" | "results";
type Trial = CptEvent;

type ApiAnalysis = {
  source?: string;
  ml_prediction?: {
    model_version: string;
    adhd_probability: number;
    classification: "adhd" | "nt";
    confidence: number;
    trained_on: string;
    accuracy: number;
  };
  layperson_insight: {
    stamina_headline: string;
    stamina_description: string;
    reaction_style_headline: string;
    reaction_style_description: string;
    actionable_habits: string[];
  };
  clinical_referral: {
    diagnostic_impression: string;
    asrs_clinical_correlation: string;
    cpt_psychometric_note: string;
    gaze_stability_note: string;
    provisional_recommendations: string[];
    formal_limitations: string[];
  };
};

// Practice mirrors real CPT: 250ms flash, random ISI 1000–2000ms between trials
const PRACTICE_SEQUENCE: Array<{ kind: "go" | "no-go"; delayMs: number }> = [
  { kind: "go",     delayMs: 1450 },
  { kind: "no-go",  delayMs: 1800 },
  { kind: "go",     delayMs: 1200 },
  { kind: "go",     delayMs: 1650 },
  { kind: "no-go",  delayMs: 1900 },
  { kind: "go",     delayMs: 1350 },
];

const DEMO_STABLE_TRACE: GazeSample[] = Array.from({ length: 64 }, (_, i) => ({
  x: 0.5 + Math.sin(i * 0.4) * 0.035 + (((i * 13) % 7) - 3) * 0.004,
  y: 0.5 + Math.cos(i * 0.4) * 0.035 + (((i * 17) % 7) - 3) * 0.004,
  valid: true,
}));

const DEMO_VARIABLE_TRACE: GazeSample[] = Array.from({ length: 64 }, (_, i) => ({
  x: 0.5 + Math.sin(i * 0.7) * 0.22 + (((i * 11) % 5) - 2) * 0.03,
  y: 0.5 + Math.cos(i * 0.5) * 0.18 + (((i * 13) % 5) - 2) * 0.03,
  valid: i % 8 !== 0,
}));

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function createSessionId() {
  return `OC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function formatSessionDate(value: number | null) {
  return value ? new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "Belum dimulai";
}

export default function ScreeningPage() {
  const [phase, setPhase] = useState<Phase>("ready");
  const user = useSyncExternalStore<SafeUser | null>(
    subscribeAuth,
    getActiveUser,
    () => null
  );

  // Tier 1: ASRS (Sesi 1: 1 page per question) & Tier 3: Physiological Context + Mode
  const [asrsStep, setAsrsStep] = useState<number>(0);
  const [asrsAnswers, setAsrsAnswers] = useState<Record<number, number>>({});
  const [asrsResult, setAsrsResult] = useState<AsrsResult | null>(null);
  const [sleepHours] = useState<SleepDuration>("6-8");
  const [caffeineRecent] = useState<boolean>(false);
  const [screenTimeHours] = useState<ScreenExposure>("2-5");
  const [testMode, setTestMode] = useState<TestMode>("quick");

  // Tier 2 Pre-flight Integrity & Environmental Protocol
  const [skipCamera, setSkipCamera] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<"off" | "starting" | "ready" | "denied">("off");
  const [isTestPaused, setIsTestPaused] = useState(false);
  const [tabDistractionCount, setTabDistractionCount] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");

  // Guided Timed Practice (6 real 250ms flash trials)
  const [practiceState, setPracticeState] = useState<"idle" | "running" | "passed" | "retry">("idle");
  const [practiceFeedback, setPracticeFeedback] = useState("Klik tombol untuk mencoba 6 stimulus kilat.");
  const [practiceScore, setPracticeScore] = useState(0);
  const [practiceRt, setPracticeRt] = useState<number | null>(null);
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [practiceKind, setPracticeKind] = useState<"go" | "no-go" | null>(null);
  const [practiceTrialVisible, setPracticeTrialVisible] = useState(false);
  const [practiceStepIndex, setPracticeStepIndex] = useState(0);
  const practiceActiveRef = useRef<{ kind: "go" | "no-go"; shownAt: number; responded: boolean } | null>(null);
  const practiceCorrectRef = useRef(0);
  const practiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const practiceFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPracticeStepRef = useRef<(idx: number) => void>(() => undefined);

  // Main CPT Running State
  const [trial, setTrial] = useState<Trial | null>(null);
  const [stimulusVisible, setStimulusVisible] = useState(false);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [, setFeedback] = useState("");

  // Results & AI State
  const [analysisMode, setAnalysisMode] = useState<"layperson" | "clinical">("layperson");
  const [analysis, setAnalysis] = useState<ApiAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [demoProfile, setDemoProfile] = useState<"stable" | "variable">("variable");
  const [sessionId, setSessionId] = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [actualDurationSec, setActualDurationSec] = useState(360);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const plannedTrials = useRef<CptTrial[]>(createStructuredCptTrials("clinical"));

  // Record gaze samples ONLY during active running phase when not paused
  const gaze = useGazeTracking(
    videoRef,
    cameraStatus === "ready",
    (phase === "running" || (phase === "ready" && practiceState === "running")) && !isTestPaused
  );

  const trialIndex = useRef(0);
  const startedAt = useRef(0);
  const pauseStartedAt = useRef<number | null>(null);
  const pausedAccumulatedMs = useRef(0);
  const targetDurationMs = useRef(CLINICAL_DURATION_MS);
  const showTrialRef = useRef<() => void>(() => undefined);
  const endSessionRef = useRef<() => void>(() => undefined);
  const startTestRef = useRef<() => void>(() => undefined);
  const trialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const trialsRef = useRef<Trial[]>([]);
  const activeTrialRef = useRef<Trial | null>(null);

  const subjectContext: SubjectContext = useMemo(
    () => ({
      sleepHours,
      caffeineRecent,
      screenTimeHours,
      timeOfDay: getDefaultTimeOfDay(),
      testMode,
    }),
    [sleepHours, caffeineRecent, screenTimeHours, testMode]
  );

  const clearTimers = useCallback(() => {
    if (trialTimer.current) clearTimeout(trialTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (endTimer.current) clearTimeout(endTimer.current);
    if (clockTimer.current) clearInterval(clockTimer.current);
    if (practiceTimerRef.current) clearTimeout(practiceTimerRef.current);
    if (practiceFlashRef.current) clearTimeout(practiceFlashRef.current);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus("off");
  }, []);

  const enableCamera = async () => {
    setCameraStatus("starting");
    setSkipCamera(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraStatus("ready");
    } catch {
      setCameraStatus("denied");
    }
  };

  useEffect(() => {
    if (cameraStatus !== "ready" || !videoRef.current || !streamRef.current) return;
    const video = videoRef.current;
    video.srcObject = streamRef.current;
    void video.play().catch(() => setCameraStatus("denied"));
  }, [cameraStatus, phase]);

  // Track fullscreen state so the integrity gate can enforce it
  useEffect(() => {
    setFullscreenSupported(document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function");
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Leaving fullscreen mid-test is treated as a focus violation
  useEffect(() => {
    if (phase === "running" && fullscreenSupported && !isFullscreen && !isTestPaused) {
      setIsTestPaused(true);
      setTabDistractionCount((prev) => prev + 1);
    }
  }, [isFullscreen, phase, fullscreenSupported, isTestPaused]);

  // Pause & resume management on tab-switch / window-blur
  useEffect(() => {
    const triggerPause = () => {
      if (phase === "running" && !isTestPaused) {
        setIsTestPaused(true);
        setTabDistractionCount((prev) => prev + 1);
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) triggerPause();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", triggerPause);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", triggerPause);
    };
  }, [phase, isTestPaused]);

  // Handle pause timer accounting cleanly
  useEffect(() => {
    if (phase !== "running") return;
    if (isTestPaused) {
      if (pauseStartedAt.current === null) {
        pauseStartedAt.current = Date.now();
      }
      clearTimers();
    } else if (pauseStartedAt.current !== null) {
      pausedAccumulatedMs.current += Date.now() - pauseStartedAt.current;
      pauseStartedAt.current = null;
      const elapsed = Date.now() - startedAt.current - pausedAccumulatedMs.current;
      const remaining = Math.max(500, targetDurationMs.current - elapsed);
      endTimer.current = setTimeout(() => endSessionRef.current(), remaining);
      trialTimer.current = setTimeout(() => showTrialRef.current(), 900);
    }
  }, [isTestPaused, phase, clearTimers]);

  // Compute per-trial GDI from gaze samples and trial events
  const allGazeSamples = useMemo(() => {
    // Build flat array of all recorded samples from the tracking hook
    return (gaze.trace as Array<{ x: number; y: number; valid: boolean; recordedAt?: number }>) ?? [];
  }, [gaze.trace]);

  const trialGdis = useMemo(
    () => calculateTrialGdis(trials, allGazeSamples),
    [trials, allGazeSamples]
  );
  const gdiSummary = useMemo(() => summarizeGdiResults(trialGdis), [trialGdis]);


  const requestAnalysisWith = useCallback(
    async (
      targetEvents: Trial[],
      targetAsrs: AsrsResult | null,
      demoFlag: boolean,
      durationSec: number,
      tabInterruptionsCount: number
    ) => {
      setAnalysisLoading(true);
      setAnalysisError(false);
      const m = calculateCptMetrics(targetEvents);
      const cStats = calculateClinicalStats(targetEvents);
      const blocks = calculateAttentionBlocks(targetEvents);
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            test_version: "2.1",
            test_mode: demoFlag ? "synthetic" : subjectContext.testMode,
            duration_seconds: Math.max(1, durationSec),
            tab_interruptions: demoFlag ? 0 : tabInterruptionsCount,
            subject_context: demoFlag ? undefined : subjectContext,
            asrs: targetAsrs
              ? {
                  total_score: targetAsrs.totalScore,
                  significant_items: targetAsrs.significantCount,
                  is_significant: targetAsrs.isSignificant,
                }
              : undefined,
            cpt: {
              go_trials: m.goTrials,
              no_go_trials: m.noGoTrials,
              hit_rate: m.hitRate,
              omission_rate: m.omissionRate,
              commission_rate: m.commissionRate,
              median_rt_ms: m.medianReactionTimeMs,
              rt_variability_ms: m.reactionTimeVariabilityMs,
              d_prime: cStats.dPrime,
              anticipatory_responses: cStats.anticipatoryResponses,
              attention_lapses: cStats.attentionLapses,
              fatigue_slope: cStats.fatigueSlope,
              rt_slope_ms_per_block: cStats.rtSlopeMsPerBlock,
            },
            blocks: blocks.map((b) => ({
              label: b.label,
              phase: b.blockPhase,
              hit_rate: b.hitRate,
              commission_rate: b.commissionRate,
              median_rt_ms: b.medianRtMs,
            })),
            gaze: {
              status: demoFlag ? "unavailable" : gaze.quality.status,
              data_coverage: demoFlag ? 0 : gaze.quality.coverage,
              relative_dispersion: demoFlag ? 0 : gaze.quality.relativeDispersion,
              out_of_bounds_rate: demoFlag ? 0 : gaze.outOfBoundsRate,
              mean_gdi: demoFlag ? 0 : (gdiSummary.meanGdi ?? 0),
              max_gdi: demoFlag ? 0 : (gdiSummary.maxGdi ?? 0),
              trials_with_gaze_data: demoFlag ? 0 : gdiSummary.trialsWithData,
            },
            ex_gaussian: demoFlag ? null : {
              mu_ms: m.exGaussian.mu,
              sigma_ms: m.exGaussian.sigma,
              tau_ms: m.exGaussian.tau,
            },
          }),
        });
        if (response.ok) {
          setAnalysis(await response.json());
        } else {
          setAnalysisError(true);
        }
      } catch {
        setAnalysisError(true);
      } finally {
        setAnalysisLoading(false);
      }
    },
    [subjectContext, gaze.quality, gaze.outOfBoundsRate, gdiSummary]
  );

  const endSession = useCallback(() => {
    const active = activeTrialRef.current;
    if (active && !active.response) {
      trialsRef.current = [...trialsRef.current, { ...active, response: classifyResponse(active.kind, false) }];
    }
    const finalTrials = trialsRef.current;
    const finalMetrics = calculateCptMetrics(finalTrials);
    const finalStats = calculateClinicalStats(finalTrials);
    const elapsedSec = Math.max(
      1,
      Math.round((Date.now() - startedAt.current - pausedAccumulatedMs.current) / 1000)
    );

    setTrials(finalTrials);
    setTrial(null);
    setStimulusVisible(false);
    setActualDurationSec(elapsedSec);
    setPhase("results");
    stopCamera();
    clearTimers();

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }

    const activeUsr = getActiveUser();
    if (activeUsr && !isDemo) {
      const exportPayload = buildSessionExport(sessionId, false, finalMetrics, gaze.quality, asrsResult, {
        clinicalStats: finalStats,
        subjectContext,
        durationSeconds: elapsedSec,
        tabInterruptions: tabDistractionCount,
        outOfBoundsRate: gaze.outOfBoundsRate,
        gdiSummary: gdiSummary,
      });
      persistSessionToStorage({
        sessionId: sessionId || "OC-LOCAL",
        userId: activeUsr.id,
        date: Date.now(),
        durationSeconds: elapsedSec,
        testMode: subjectContext.testMode,
        asrsTotalScore: asrsResult?.totalScore ?? 0,
        asrsSignificant: asrsResult?.isSignificant ?? false,
        medianRtMs: finalMetrics.medianReactionTimeMs,
        hitRate: finalMetrics.hitRate,
        omissions: finalMetrics.omissions,
        commissions: finalMetrics.commissions,
        dPrime: finalStats.dPrime,
        gazeStatus: gaze.quality.status,
        exportPayload,
      });
    }

    void requestAnalysisWith(finalTrials, asrsResult, false, elapsedSec, tabDistractionCount);
  }, [
    clearTimers,
    stopCamera,
    isDemo,
    sessionId,
    asrsResult,
    gaze.quality,
    gaze.outOfBoundsRate,
    subjectContext,
    tabDistractionCount,
    requestAnalysisWith,
    gdiSummary,
  ]);

  useEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  const showTrial = useCallback(() => {
    if (isTestPaused) return;
    const elapsed = Date.now() - startedAt.current - pausedAccumulatedMs.current;
    if (elapsed >= targetDurationMs.current) {
      endSessionRef.current();
      return;
    }

    // Close previous unresponded trial cleanly
    const previous = activeTrialRef.current;
    if (previous && !previous.response) {
      const completed = { ...previous, response: classifyResponse(previous.kind, false) };
      trialsRef.current = [...trialsRef.current, completed];
      setTrials(trialsRef.current);
    }

    if (trialIndex.current >= plannedTrials.current.length) {
      endSessionRef.current();
      return;
    }

    const planned = plannedTrials.current[trialIndex.current];
    trialIndex.current += 1;
    const next: Trial = { ...planned, shownAt: performance.now() };
    activeTrialRef.current = next;
    setTrial(next);
    setStimulusVisible(true);
    setFeedback("Amati stimulus kilat · Fokus pada tanda (+)");

    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      setStimulusVisible(false);
    }, 250);

    trialTimer.current = setTimeout(() => showTrialRef.current(), next.delayMs);
  }, [isTestPaused]);

  useEffect(() => {
    showTrialRef.current = showTrial;
  }, [showTrial]);

  const startTest = useCallback(() => {
    clearTimers();
    gaze.reset();
    const duration = subjectContext.testMode === "clinical" ? CLINICAL_DURATION_MS : QUICK_DURATION_MS;
    targetDurationMs.current = duration;
    plannedTrials.current = createStructuredCptTrials(subjectContext.testMode);
    startedAt.current = Date.now();
    pauseStartedAt.current = null;
    pausedAccumulatedMs.current = 0;

    const newId = createSessionId();
    setSessionId(newId);
    setSessionStartedAt(Date.now());
    trialIndex.current = 0;
    trialsRef.current = [];
    activeTrialRef.current = null;
    setTabDistractionCount(0);
    setIsTestPaused(false);
    setAnalysis(null);
    setAnalysisError(false);
    setTrials([]);
    setTrial(null);
    setStimulusVisible(false);
    setPhase("running");
    setFeedback("Bersiap… fiksasikan mata pada tanda (+) di tengah layar.");

    trialTimer.current = setTimeout(() => showTrialRef.current(), 1200);
    endTimer.current = setTimeout(() => endSessionRef.current(), duration);
    clockTimer.current = setInterval(() => {
      // internal clock tracking
    }, 1000);
  }, [clearTimers, gaze, subjectContext]);

  useEffect(() => {
    startTestRef.current = startTest;
  }, [startTest]);

  // Guided Timed Flash Practice Engine
  const runPracticeStep = (idx: number) => {
    if (idx >= PRACTICE_SEQUENCE.length) {
      const score = practiceCorrectRef.current;
      setPracticeScore(score);
      if (score >= 4) {
        setPracticeState("passed");
        setPracticeFeedback(`Latihan lulus (${score}/${PRACTICE_SEQUENCE.length} benar). Kalibrasi motorik siap.`);
      } else {
        setPracticeState("retry");
        setPracticeFeedback(`Akurasi latihan rendah (${score}/${PRACTICE_SEQUENCE.length}). Ulangi agar paham pola kilat 250ms.`);
      }
      return;
    }

    const step = PRACTICE_SEQUENCE[idx];
    practiceActiveRef.current = { kind: step.kind, shownAt: performance.now(), responded: false };
    setPracticeStepIndex(idx);
    setPracticeKind(step.kind);

    setPracticeRt(null);
    setPracticeTrialVisible(true);
    setPracticeFeedback(step.kind === "go" ? "HIJAU: Tekan SPACE / Tombol sekarang!" : "MERAH: Tahan, jangan tekan!");

    practiceFlashRef.current = setTimeout(() => setPracticeTrialVisible(false), 250);

    practiceTimerRef.current = setTimeout(() => {
      const active = practiceActiveRef.current;
      if (active && !active.responded) {
        if (active.kind === "no-go") {
          practiceCorrectRef.current += 1;
          setPracticeFeedback("Bagus! Berhasil menahan diri pada No-Go.");
        } else {
          setPracticeFeedback("Terlewat: target hijau terlalu cepat lewat.");
        }
      }
      runPracticeStepRef.current(idx + 1);
    }, step.delayMs);
  };

  useEffect(() => {
    runPracticeStepRef.current = runPracticeStep;
  });

  const startGuidedPractice = () => {
    if (practiceTimerRef.current) clearTimeout(practiceTimerRef.current);
    if (practiceFlashRef.current) clearTimeout(practiceFlashRef.current);
    practiceCorrectRef.current = 0;
    practiceActiveRef.current = null;
    setPracticeStepIndex(0);
    setPracticeScore(0);
    setPracticeRt(null);
    setPracticeKind(null);

    setPracticeTrialVisible(false);
    setPracticeState("running");
    setPracticeFeedback("Bersiap melihat 6 stimulus kilat 250ms…");
    practiceTimerRef.current = setTimeout(() => runPracticeStep(0), 800);
  };

  const handlePracticeRespond = useCallback(() => {
    if (practiceState !== "running") return;
    const active = practiceActiveRef.current;
    if (!active || active.responded) return;
    active.responded = true;
    const rt = Math.round(performance.now() - active.shownAt);
    setPracticeRt(rt);
    if (active.kind === "go") {
      practiceCorrectRef.current += 1;
      if (rt < 200) setPracticeFeedback(`Cepat sekali! (${rt} ms)`);
      else if (rt > 600) setPracticeFeedback(`Terlambat... (${rt} ms)`);
      else setPracticeFeedback(`Tepat! (${rt} ms)`);
    } else {
      practiceCorrectRef.current -= 1;
      setPracticeFeedback("Komisi! Tahan saat merah.");
    }
  }, [practiceState]);

  const loadBenchmark = (profile: "stable" | "variable") => {
    clearTimers();
    stopCamera();
    gaze.reset();
    const structured = createStructuredCptTrials("clinical", 20261111);
    const benchmark: Trial[] = structured.map((planned, index) => {
      const shownAt = index * planned.delayMs;
      const blockIdx = planned.blockIndex ?? 0;
      const isLateBlock = blockIdx >= 3;
      const shouldRespond =
        profile === "stable"
          ? planned.kind === "go"
            ? index % 29 !== 0
            : false
          : planned.kind === "go"
          ? isLateBlock
            ? index % 3 !== 0
            : index % 8 !== 0
          : isLateBlock && index % 4 === 0;
      const baseRt = profile === "stable" ? 365 + (index % 5) * 14 : 420 + blockIdx * 28 + (index % 7) * 35;
      return {
        ...planned,
        shownAt,
        ...(shouldRespond
          ? {
              respondedAt: shownAt + (planned.kind === "go" ? baseRt : 195),
              response: classifyResponse(planned.kind, true),
            }
          : { response: classifyResponse(planned.kind, false) }),
      };
    });

    const demoAsrs: AsrsResult = {
      totalScore: profile === "stable" ? 6 : 17,
      significantCount: profile === "stable" ? 1 : 5,
      isSignificant: profile !== "stable",
      interpretationLay:
        profile === "stable"
          ? "Pengakuan harianmu berada dalam rentang wajar dan stabil."
          : "Pengakuan harianmu menunjukkan frekuensi kesulitan konsentrasi yang signifikan.",
      interpretationClinical:
        profile === "stable"
          ? "Skor ASRS v1.1 Part A menunjukkan 1/6 item positif (normal)."
          : "Skor ASRS v1.1 Part A menunjukkan 5/6 item positif (signifikan secara klinis).",
    };

    trialsRef.current = benchmark;
    setSessionId(`DEMO-${profile.toUpperCase()}`);
    setSessionStartedAt(null);
    setActualDurationSec(360);
    setAnalysis(null);
    setAnalysisError(false);
    setTrials(benchmark);
    setTrial(null);
    setStimulusVisible(false);
    setIsDemo(true);
    setDemoProfile(profile);
    setAsrsResult(demoAsrs);
    setPhase("results");
    void requestAnalysisWith(benchmark, demoAsrs, true, 360, 0);
  };

  const respond = useCallback(() => {
    if (phase === "ready" && practiceState === "running") {
      handlePracticeRespond();
      return;
    }
    if (phase !== "running" || isTestPaused) return;
    const active = activeTrialRef.current;
    if (!active || active.response) return;
    const response: Trial["response"] = active.kind === "go" ? "hit" : "commission";
    const completed = { ...active, respondedAt: performance.now(), response };
    activeTrialRef.current = completed;
    trialsRef.current = [...trialsRef.current, completed];
    setTrials(trialsRef.current);
    setFeedback(response === "hit" ? "Tepat ✓" : "Terburu-buru · tahan saat merah");
  }, [phase, isTestPaused, practiceState, handlePracticeRespond]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Space" && (phase === "running" || (phase === "ready" && practiceState === "running"))) {
        event.preventDefault();
        respond();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [respond, phase, practiceState]);

  // Countdown 3-2-1 then auto-start CPT after practice passes
  useEffect(() => {
    if (phase !== "ready" || practiceState !== "passed" || countdownNum !== null) return;
    let tick = 3;
    setCountdownNum(tick);
    const id = setInterval(() => {
      tick -= 1;
      if (tick <= 0) {
        clearInterval(id);
        setCountdownNum(null);
        startTestRef.current();
      } else {
        setCountdownNum(tick);
      }
    }, 800);
    return () => clearInterval(id);
  }, [phase, practiceState, countdownNum]);

  useEffect(() => {
    if (phase === "running" || phase === "questionnaire") setCountdownNum(null);
  }, [phase]);

  useEffect(() => () => {
    clearTimers();
    stopCamera();
  }, [clearTimers, stopCamera]);

  const metrics = useMemo(() => calculateCptMetrics(trials), [trials]);
  const clinicalStats = useMemo(() => calculateClinicalStats(trials), [trials]);
  const attentionBlocks = useMemo(() => calculateAttentionBlocks(trials), [trials]);

  const printSummary = () => window.print();

  const downloadJson = () => {
    const exportPayload = buildSessionExport(sessionId, isDemo, metrics, gaze.quality, asrsResult, {
      clinicalStats,
      subjectContext,
      durationSeconds: actualDurationSec,
      tabInterruptions: tabDistractionCount,
      outOfBoundsRate: gaze.outOfBoundsRate,
      gdiSummary,
    });
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportPayload.session_id.toLowerCase()}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const resumeTest = async () => {
    if (fullscreenSupported && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
        setFullscreenError("");
      } catch {
        setFullscreenError("Kembali ke layar penuh diperlukan sebelum melanjutkan tes.");
        return;
      }
    }
    setIsTestPaused(false);
  };

  const finishSesi1AndStartCpt = () => {
    const scored = scoreAsrs(asrsAnswers);
    setAsrsResult(scored);
    setIsDemo(false);
    startTestRef.current();
  };

  const currentAsrsQuestion = ASRS_QUESTIONS[asrsStep] ?? ASRS_QUESTIONS[0];
  const currentAsrsAnswered = asrsAnswers[currentAsrsQuestion.id] !== undefined;
  return (
    <main className={`site-shell screening-shell ${(phase === "ready" && practiceState !== "running") || phase === "running" ? "exam-mode-hide-nav" : ""}`}>
      {(phase !== "ready" && phase !== "running") && (
      <nav className="nav-wrap">
        <Link className="brand" href="/">
          <span className="brand-mark">OC</span>
          <span>OculiCare</span>
        </Link>
        <div className="nav-center-menu">
          <Link href="/">Beranda</Link>
          <span className="status-pill">
            {phase === "questionnaire"
              ? `Sesi 1, soal ${asrsStep + 1} dari ${ASRS_QUESTIONS.length}`
              : phase === "results"
              ? "Ringkasan hasil"
              : "Persiapan"}
          </span>
        </div>
        <div className="nav-right-actions">
          <ThemeToggle />
          {user ? (
            <ProfileIconButton user={user} />
          ) : (
            <Link className="text-link" href="/login">
              Masuk
            </Link>
          )}
        </div>
      </nav>
      )}

      {/* STEP 2 (SESI 1): WHO ASRS - Zen Likert Scale 1 Soal per Halaman */}
      {phase === "questionnaire" && (
        <section className="lab-viewport">
          <div className="lab-frame">
            <div className="lab-header">
              <span className="lab-tag">Kuesioner WHO ASRS v1.1</span>
              <span className="lab-step-indicator">
                Soal {String(asrsStep + 1).padStart(2, "0")} / {String(ASRS_QUESTIONS.length).padStart(2, "0")}
              </span>
            </div>

            <div className="question-statement">
              {currentAsrsQuestion.question}
            </div>

            <div className="likert-scale">
              {ASRS_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={`likert-btn ${asrsAnswers[currentAsrsQuestion.id] === opt.value ? "selected" : ""}`}
                  onClick={() => setAsrsAnswers((prev) => ({ ...prev, [currentAsrsQuestion.id]: opt.value }))}
                >
                  <span className="scale-num">0{opt.value}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>

            <div className="lab-footer">
              {asrsStep > 0 ? (
                <button type="button" className="secondary-button" onClick={() => setAsrsStep((s) => Math.max(0, s - 1))}>
                  Kembali
                </button>
              ) : (
                <button type="button" className="secondary-button" onClick={() => setPhase("ready")}>
                  Kembali ke persiapan
                </button>
              )}

              {asrsStep < ASRS_QUESTIONS.length - 1 ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!currentAsrsAnswered}
                  onClick={() => setAsrsStep((s) => Math.min(ASRS_QUESTIONS.length - 1, s + 1))}
                >
                  Soal berikutnya
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!currentAsrsAnswered}
                  onClick={finishSesi1AndStartCpt}
                >
                  Mulai pengecekan CPT
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* STEP 1 (PERSIAPAN): Minimal — kamera saja, tidak bisa diselesaikan */}
      {phase === "ready" && practiceState !== "running" && (
        <section className="lab-viewport">
          <div className="lab-frame" style={{ textAlign: "center", padding: "48px 24px" }}>
            <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", margin: "0 0 20px", lineHeight: 1.6 }}>
              Arahkan wajah Anda ke kamera dan pastikan cahaya cukup.<br />
              Tes akan dimulai secara otomatis setelah persiapan selesai.
            </p>

            {/* Circular Camera Preview */}
            <div className="reticle-container" style={{ maxWidth: 320, margin: "0 auto 28px" }}>
              {cameraStatus === "ready" ? (
                <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: "50%" }} />
              ) : (
                <div className="reticle-placeholder" style={{ height: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span className="reticle-hint-label">Kamera siap</span>
                  <span className="reticle-hint-sub">Pusatkan wajah di dalam lingkaran</span>
                </div>
              )}
              <div className="reticle-crosshair" />
            </div>

            {/* Controls */}
            <div style={{ display: "flex", gap: "10px", justifyContent: "center", marginBottom: "20px", flexWrap: "wrap" }}>
              {cameraStatus !== "ready" ? (
                <button type="button" className="primary-button" onClick={enableCamera} disabled={cameraStatus === "starting"}>
                  {cameraStatus === "starting" ? "Menghubungkan..." : "Aktifkan kamera"}
                </button>
              ) : (
                <button type="button" className="secondary-button" onClick={stopCamera}>Matikan kamera</button>
              )}
              <button
                type="button"
                className="secondary-button"
                aria-pressed={skipCamera}
                style={skipCamera ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                onClick={() => setSkipCamera((prev) => !prev)}
              >
                {skipCamera ? "Mode tanpa kamera aktif" : "Lanjut tanpa kamera"}
              </button>
            </div>

            {/* Demo load */}
            <button
              type="button"
              className="secondary-button"
              style={{ fontSize: "0.74rem", padding: "5px 12px", opacity: 0.6 }}
              onClick={() => loadBenchmark("stable")}
            >
              Muat data demo
            </button>

            {/* Test mode selector */}
            <div style={{ marginTop: "20px", display: "flex", alignItems: "center", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>Mode tes:</span>
              <button
                type="button"
                className={testMode === "quick" ? "primary-button" : "secondary-button"}
                style={{ padding: "4px 12px", fontSize: "0.78rem", height: "auto" }}
                onClick={() => setTestMode("quick")}
              >
                Cepat (90 detik)
              </button>
              <button
                type="button"
                className={testMode === "clinical" ? "primary-button" : "secondary-button"}
                style={{ padding: "4px 12px", fontSize: "0.78rem", height: "auto" }}
                onClick={() => setTestMode("clinical")}
              >
                Standar (3 menit)
              </button>
            </div>

            {/* Practice section */}
            <div style={{ marginTop: "24px", borderTop: "1px solid var(--surface-border)", paddingTop: "20px" }}>
              {practiceState === "idle" && (
                <div>
                  <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", margin: "0 0 6px", fontWeight: 500 }}>
                    Simulasi latihan — 6 stimulus persis seperti tes utama
                  </p>
                  <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.5 }}>
                    Lingkaran <span style={{ color: "var(--accent)", fontWeight: 600 }}>hijau</span> = tekan SPASI&ensp;·&ensp;
                    Kotak <span style={{ color: "#b42318", fontWeight: 600 }}>merah</span> = tahan tangan
                  </p>
                  <button type="button" className="primary-button" onClick={startGuidedPractice}>
                    Mulai Latihan
                  </button>
                </div>
              )}
              {practiceState === "passed" && (
                <div>
                  <p style={{ fontSize: "0.92rem", color: "var(--accent)", margin: "0 0 10px", fontWeight: 600 }}>
                    ✓ {practiceFeedback}
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => { setPracticeState("passed"); startTestRef.current(); }}
                  >
                    Lanjut ke Tes Utama →
                  </button>
                </div>
              )}
              {practiceState === "retry" && (
                <div>
                  <p style={{ fontSize: "0.88rem", color: "var(--warning)", margin: "0 0 12px" }}>
                    {practiceFeedback}
                  </p>
                  <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                    <button type="button" className="primary-button" onClick={startGuidedPractice}>
                      Ulangi Latihan
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => { setPracticeState("passed"); startTestRef.current(); }}
                    >
                      Tetap lanjut →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* PRACTICE CANVAS — full-screen mirror of the real CPT test */}
      {practiceState === "running" && (
        <section className="pure-cpt-canvas exam-white" aria-live="polite" role="presentation">
          <div className="cpt-crosshair" />
          <div className="clinical-stimulus">
            {practiceTrialVisible && practiceKind && (
              <div className={`stimulus-shape ${practiceKind === "no-go" ? "shape-stop" : ""}`} />
            )}
          </div>

          {/* Practice HUD — subtly overlaid at bottom */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              padding: "14px 24px 18px",
              background: "linear-gradient(to top, rgba(255,255,255,0.97) 60%, transparent)",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              pointerEvents: "none",
            }}
          >
            <div style={{ pointerEvents: "auto" }}>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: "0 0 2px" }}>
                Latihan · Trial {practiceStepIndex + 1} / {PRACTICE_SEQUENCE.length}
              </p>
              <p style={{ fontSize: "0.72rem", color: "var(--text-secondary)", margin: 0 }}>
                {practiceFeedback}
                {practiceRt !== null && `&ensp;·&ensp;${practiceRt} ms`}
              </p>
            </div>
            <div style={{ textAlign: "right", pointerEvents: "auto" }}>
              <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", margin: "0 0 2px" }}>Skor</p>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--accent)", margin: 0, lineHeight: 1 }}>
                {practiceScore}<span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontWeight: 400 }}>/{PRACTICE_SEQUENCE.length}</span>
              </p>
            </div>
          </div>
        </section>
      )}

      {/* PHASE 3: Pure Sensory Blind CPT Stage — white exam-paper look, no nav, no hint */}
      {phase === "running" && (
        <section className="pure-cpt-canvas exam-white" aria-live="polite">
          {isTestPaused && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 110,
                background: "rgba(5, 7, 10, 0.96)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
                textAlign: "center",
              }}
            >
              <h2 style={{ fontSize: "1.4rem", fontWeight: 700, margin: "0 0 10px", color: "#ffffff" }}>
                Tes Dijeda: Fokus Layar Terputus
              </h2>
              <p style={{ maxWidth: "420px", color: "var(--text-secondary)", fontSize: "0.85rem", lineHeight: 1.5, margin: "0 0 16px" }}>
                Jendela browser kehilangan fokus atau keluar dari layar penuh. Waktu dijaga akurat tanpa mengurangi durasi. Interupsi: {tabDistractionCount}x.
              </p>
              {fullscreenError && (
                <p style={{ maxWidth: "420px", color: "#fca5a5", fontSize: "0.78rem", lineHeight: 1.5, margin: "0 0 16px" }} role="alert">
                  {fullscreenError}
                </p>
              )}
              <button
                type="button"
                className="primary-button"
                onClick={() => void resumeTest()}
              >
                Lanjutkan Tes →
              </button>
            </div>
          )}

          {cameraStatus === "ready" && (
            <video ref={videoRef} className="camera-pip" muted playsInline aria-hidden="true" />
          )}

          <div className="cpt-crosshair" />

          {/* Clinical Geometric Stimulus: Circle (Go) / Square (No-Go) as in QbTest/TOVA */}
          <div className="clinical-stimulus">
            {stimulusVisible && trial && (
              <div
                className={`stimulus-shape ${trial.kind === "no-go" ? "shape-stop" : ""}`}
              />
            )}
          </div>
        </section>
      )}

      {/* PHASE 4: Dual-Tone Results Dashboard & Clinical A4 Referral */}
      {phase === "results" && (
        <section className="screening-content">
          <div className="results-header">
            <div className="status-pill">
              <span className="status-dot" />{" "}
              {isDemo
                ? `Simulasi benchmark 6 blok, profil ${demoProfile}`
                : `Sesi selesai (${actualDurationSec} detik), ${formatSessionDate(sessionStartedAt)}`}
            </div>
            <h1 style={{ color: "var(--text-primary)" }}>
              Hasil pengamatan <em>ritme fokusmu.</em>
            </h1>
            <p className="hero-lede" style={{ marginBottom: "14px" }}>
              ID sesi: <strong>{sessionId || "OC-LOCAL"}</strong> ·{" "}
              {isDemo ? "Data benchmark sintetis" : formatSubjectContextLabel(subjectContext)}
            </p>
          </div>

          {/* DUAL COPYWRITING TABS */}
          <div className="dual-tone-tabs btn-no-print">
            <button
              type="button"
              className={`tab-btn ${analysisMode === "layperson" ? "active" : ""}`}
              onClick={() => setAnalysisMode("layperson")}
            >
              Penjelasan untuk saya
            </button>
            <button
              type="button"
              className={`tab-btn ${analysisMode === "clinical" ? "active" : ""}`}
              onClick={() => setAnalysisMode("clinical")}
            >
              Lembar rujukan medis
            </button>
          </div>

          {/* 3 CORE PILLARS CARD GRID */}
          <div className="results-grid-cards">
            <div className="result-card">
              <div>
                <div className="result-card-title">
                  {analysisMode === "layperson" ? "Stamina fokus dan kecepatan" : "Kecepatan psikomotor dan RTV"}
                </div>
                <div className="result-card-value">{metrics.medianReactionTimeMs ?? 0} ms</div>
                <div className="result-card-desc">
                  {analysisMode === "layperson"
                    ? "Waktu rata-rata otakmu merespons target hijau yang muncul sekejap."
                    : `Median RT: ${metrics.medianReactionTimeMs ?? 0} ms · RTV (variabilitas): ${metrics.reactionTimeVariabilityMs ?? 0} ms · Fatigue slope: ${clinicalStats.fatigueSlope ?? 0}/blok.`}
                </div>
              </div>
              <div style={{ marginTop: "16px", fontSize: "0.78rem", fontWeight: 700, color: "var(--accent-teal)" }}>
                Ketepatan Go: {percent(metrics.hitRate)} · Lapse (&gt;750 ms): {clinicalStats.attentionLapses}
              </div>
            </div>

            <div className="result-card">
              <div>
                <div className="result-card-title">
                  {analysisMode === "layperson" ? "Kontrol impuls dan kelengahan" : "Inhibisi dan deteksi sinyal (d')"}
                </div>
                <div className="result-card-value">
                  {analysisMode === "layperson"
                    ? `${metrics.commissions} salah`
                    : `d' = ${clinicalStats.dPrime ?? "N/A"}`}
                </div>
                <div className="result-card-desc">
                  {analysisMode === "layperson"
                    ? "Berapa kali jari terburu-buru menekan target merah yang harusnya ditahan."
                    : `Commission rate: ${percent(metrics.commissionRate)} (${metrics.commissions}x) · Omission rate: ${percent(metrics.omissionRate)} (${metrics.omissions}x).`}
                </div>
              </div>
              <div style={{ marginTop: "16px", fontSize: "0.78rem", fontWeight: 700, color: "var(--coral-danger)" }}>
                Terlewat (omission): {metrics.omissions} · Antisipasi (&lt;120 ms): {clinicalStats.anticipatoryResponses}
              </div>
            </div>

            <div className="result-card">
              <div>
                <div className="result-card-title">
                  {analysisMode === "layperson" ? "Keluhan harian (WHO ASRS)" : "Trait kronis dan konteks"}
                </div>
                <div className="result-card-value">
                  {asrsResult ? `${asrsResult.significantCount}/6` : "-"}
                </div>
                <div className="result-card-desc">
                  {analysisMode === "layperson"
                    ? asrsResult?.isSignificant
                      ? "Keluhan sulit fokus dalam 6 bulan terakhir cukup sering dirasakan."
                      : "Keluhan konsentrasi harian masih dalam batas wajar."
                    : asrsResult?.interpretationClinical}
                </div>
              </div>
              <div style={{ marginTop: "16px", fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)" }}>
                Skor ASRS: {asrsResult?.totalScore ?? 0}/24 · Interupsi tab: {tabDistractionCount}x
              </div>
            </div>

            {/* ML Prediction Card */}
            {analysis?.ml_prediction && analysisMode === "clinical" && (
              <div className="result-card" style={{ borderColor: "var(--accent-teal)" }}>
                <div>
                  <div className="result-card-title">Klasifikasi ML (Logistic Regression)</div>
                  <div className="result-card-value" style={{ color: analysis.ml_prediction.classification === "adhd" ? "var(--coral-danger)" : "var(--accent-teal)" }}>
                    {analysis.ml_prediction.classification === "adhd" ? "Risk Profile: ADHD-pattern" : "Pattern: Neurotypical"}
                  </div>
                  <div className="result-card-desc">
                    Probabilitas distribusi ADHD: {(analysis.ml_prediction.adhd_probability * 100).toFixed(0)}% · Confidence: {(analysis.ml_prediction.confidence * 100).toFixed(0)}%
                  </div>
                </div>
                <div style={{ marginTop: "16px", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Model: {analysis.ml_prediction.model_version} · Akurasi training: {(analysis.ml_prediction.accuracy * 100).toFixed(0)}%
                </div>
              </div>
            )}

            {/* Ex-Gaussian + GDI Info Card */}
            <div className="result-card">
              <div>
                <div className="result-card-title">
                  {analysisMode === "layperson" ? "Stamina & kontrol impuls terukur" : "Ex-Gaussian decomposition & Gaze Dispersion"}
                </div>
                <div className="result-card-desc" style={{ fontSize: "0.78rem", lineHeight: 1.6 }}>
                  {metrics.exGaussian.tau !== null && (
                    <>
                      <strong>Tau (impulsivitas):</strong> {metrics.exGaussian.tau} ms ·{' '}
                      <strong>Mu (pemrosesan):</strong> {metrics.exGaussian.mu} ms ·{' '}
                      <strong>Sigma (variabilitas):</strong> {metrics.exGaussian.sigma} ms
                      <br />
                    </>
                  )}
                  {gdiSummary.meanGdi !== null ? (
                    <>
                      <strong>GDI rata-rata:</strong> {gdiSummary.meanGdi.toFixed(3)} satuan layar ({gdiSummary.trialsWithData} trial terukur) · Max: {gdiSummary.maxGdi?.toFixed(3)}
                    </>
                  ) : (
                    "Data tatapan mata tidak tersedia — sensor okulomotorik dilewati atau coverage rendah."
                  )}
                </div>
              </div>
              <div style={{ marginTop: "12px", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                {metrics.exGaussian.tau !== null && metrics.exGaussian.tau > 35
                  ? "Tau tinggi mengindikasikan right-skew pada distribusi waktu reaksi — pola khas impulsivitas motorik."
                  : metrics.exGaussian.tau !== null
                  ? "Tau dalam rentang normal — distribusi waktu reaksi cenderung simetris."
                  : ""}
                {gdiSummary.meanGdi !== null && gdiSummary.meanGdi > 0.08
                  ? " GDI tinggi menunjukkan dispersi tatapan luas dari target — kemungkinan mind-wandering saat tugas."
                  : gdiSummary.meanGdi !== null
                  ? " GDI rendah menunjukkan fiksasi stabil pada area target."
                  : ""}
              </div>
            </div>
          </div>

          {/* DUAL INSIGHT / CLINICAL REFERRAL PANEL */}
          <div className="analysis-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", gap: "12px", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "0.95rem", color: "var(--text-primary)" }}>
                {analysisMode === "layperson" ? "Kesimpulan dan kebiasaan harian" : "Ringkasan rujukan klinis"}
              </strong>
              <button
                type="button"
                className="secondary-button btn-no-print"
                style={{ padding: "6px 14px", fontSize: "0.75rem" }}
                onClick={() => void requestAnalysisWith(trials, asrsResult, isDemo, actualDurationSec, tabDistractionCount)}
                disabled={analysisLoading}
              >
                {analysisLoading ? "Menganalisis..." : "Perbarui analisis"}
              </button>
            </div>

            {analysis ? (
              analysisMode === "layperson" ? (
                <div>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 700, margin: "0 0 6px", color: "var(--accent-teal)" }}>
                    {analysis.layperson_insight.stamina_headline} · {analysis.layperson_insight.reaction_style_headline}
                  </h3>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: "0 0 8px", lineHeight: 1.55 }}>
                    {analysis.layperson_insight.stamina_description}
                  </p>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: "0 0 14px", lineHeight: 1.55 }}>
                    {analysis.layperson_insight.reaction_style_description}
                  </p>
                  <strong style={{ fontSize: "0.82rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-primary)" }}>
                    Langkah praktis yang bisa dicoba
                  </strong>
                  <ul style={{ margin: "8px 0 0", paddingLeft: "20px", fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
                    {analysis.layperson_insight.actionable_habits.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div>
                  <div style={{ background: "var(--surface-elevated)", padding: "12px", borderRadius: "10px", marginBottom: "12px", border: "1px solid var(--surface-border)" }}>
                    <strong style={{ color: "var(--text-primary)" }}>Batasan triase: </strong>
                    <span style={{ fontSize: "0.84rem", color: "var(--text-secondary)" }}>
                      {analysis.clinical_referral.diagnostic_impression}
                    </span>
                  </div>
                  <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: "0 0 8px" }}>
                    <strong style={{ color: "var(--text-primary)" }}>Korelasi ASRS dan konteks: </strong>
                    {analysis.clinical_referral.asrs_clinical_correlation}
                  </p>
                  <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: "0 0 8px" }}>
                    <strong style={{ color: "var(--text-primary)" }}>Psikometri CPT: </strong>
                    {analysis.clinical_referral.cpt_psychometric_note}
                  </p>
                  <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: "0 0 12px" }}>
                    <strong style={{ color: "var(--text-primary)" }}>Stabilitas okulomotor: </strong>
                    {analysis.clinical_referral.gaze_stability_note}
                  </p>
                  <strong style={{ fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-primary)" }}>Rekomendasi tindak lanjut</strong>
                  <ul style={{ margin: "6px 0 10px", paddingLeft: "18px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    {analysis.clinical_referral.provisional_recommendations.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  <strong style={{ fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-primary)" }}>Keterbatasan metodologis</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    {analysis.clinical_referral.formal_limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              )
            ) : (
              <div style={{ padding: "12px 0", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                {analysisLoading
                  ? "Menyusun analisis triangulasi (ASRS, CPT 6 blok, dan konteks)..."
                  : analysisError
                  ? "Analisis eksternal gagal dimuat. Klik perbarui analisis untuk mencoba ulang."
                  : "Menyiapkan ringkasan hasil..."}
              </div>
            )}
          </div>

          {/* Multi-Block Attention Fatigue Curve */}
          <div className="attention-curve">
            <div className="curve-heading">
              <strong>Kurva stamina dan kecepatan per blok ({attentionBlocks.length} blok)</strong>
              <span>
                Fatigue slope: {clinicalStats.fatigueSlope ?? 0}/blok · RT slope: {clinicalStats.rtSlopeMsPerBlock ?? 0} ms/blok
              </span>
            </div>
            <div className="curve-bars">
              {attentionBlocks.map((b) => (
                <div className="curve-column" key={b.index}>
                  <div style={{ fontSize: "0.62rem", color: "var(--text-secondary)" }}>
                    {b.medianRtMs ? `${b.medianRtMs}ms` : "-"}
                  </div>
                  <div className="curve-track">
                    <div
                      className="curve-fill"
                      style={{ height: `${Math.max(8, Math.round(b.hitRate * 100))}%` }}
                    />
                  </div>
                  <span>
                    B{b.index + 1} ({Math.round(b.hitRate * 100)}%)
                  </span>
                  {b.blockPhase && (
                    <span style={{ fontSize: "0.58rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
                      {b.blockPhase}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="curve-legend" style={{ marginTop: "10px" }}>
              <span>Penurunan bar di blok 3 sampai 6 mencerminkan kelelahan atensi saat tugas monoton atau tekanan tinggi.</span>
            </div>
          </div>

          {/* Gaze Plot */}
          {((!isDemo && gaze.quality.status !== "unavailable") || isDemo) && (
            <div className="gaze-panel">
              <div className="curve-heading">
                <strong>Kestabilan fiksasi mata {isDemo ? "(simulasi sintetis)" : `(${gaze.quality.status})`}</strong>
                <span>
                  {isDemo
                    ? "64 titik benchmark"
                    : `Cakupan: ${percent(gaze.quality.coverage)} · Di luar batas: ${percent(gaze.outOfBoundsRate)}`}
                </span>
              </div>
              <div className="gaze-plot">
                {(isDemo ? (demoProfile === "stable" ? DEMO_STABLE_TRACE : DEMO_VARIABLE_TRACE) : gaze.trace)
                  .filter((s) => s.valid)
                  .map((s, i) => (
                    <i
                      key={i}
                      style={{
                        left: `${Math.max(0, Math.min(1, s.x)) * 100}%`,
                        top: `${Math.max(0, Math.min(1, s.y)) * 100}%`,
                      }}
                    />
                  ))}
              </div>
              <p style={{ fontSize: "0.74rem", color: "var(--text-muted)", margin: "8px 0 0" }}>
                {isDemo
                  ? "Peta dispersi tatapan sintetis untuk demonstrasi perbandingan profil stabil vs mudah teralihkan."
                  : "Semakin terpusat titik di persimpangan salib (+), semakin stabil fiksasi pandanganmu pada area target."}
              </p>
            </div>
          )}

          {/* Footer Actions & Export */}
          <div className="hero-actions btn-no-print" style={{ marginTop: "28px" }}>
            <button className="primary-button" onClick={printSummary}>
              Cetak lembar rujukan (PDF A4)
            </button>
            <button className="secondary-button" onClick={downloadJson}>
              Unduh data telemetri (JSON)
            </button>
            {user && (
              <Link className="secondary-button" href="/dashboard">
                Lihat di dashboard riwayat
              </Link>
            )}
            <button
              className="secondary-button"
              onClick={() => {
                setIsDemo(false);
                setAsrsStep(0);
                setAsrsAnswers({});
                setPracticeState("idle");
                setPhase("ready");
              }}
            >
              Ulangi tes
            </button>
            <Link className="text-link" href="/">
              Kembali ke Beranda
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
