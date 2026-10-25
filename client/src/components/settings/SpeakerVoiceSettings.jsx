import { useState, useEffect, useRef } from "react";
import {
  Mic,
  Fingerprint,
  Play,
  Pause,
  Trash2,
  Square,
  Sliders,
  Plus,
  X,
  ShieldCheck,
} from "lucide-react";
import {
  getSpeakerStatus,
  getSpeakerProfile,
  updateSpeakerThresholds,
  enrollSpeakerVoice,
  deleteSpeakerProfile,
  verifySpeakerAudio,
} from "../../services/chatApi";
import { VoiceSampleRecorder } from "../../utils/audioRecorder";
import { speakerVerificationService } from "../../services/speakerVerificationService";
import { SL } from "./settingsLayout";

export function SpeakerVoiceSettings({ settings = {}, onSettingChange }) {
  const [profile, setProfile] = useState(null);
  const [isRecordingOpen, setIsRecordingOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [recordedSamples, setRecordedSamples] = useState([]);
  const [playingIdx, setPlayingIdx] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Testing
  const [isTestingRecording, setIsTestingRecording] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");

  // Sensitivity & Privacy Policy
  const [userThreshold, setUserThreshold] = useState(0.50);
  const [gateMode, setGateMode] = useState(() => {
    return (typeof localStorage !== "undefined" && localStorage.getItem("rie_gate_mode")) || "drop";
  });

  const handleGateModeChange = (mode) => {
    setGateMode(mode);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("rie_gate_mode", mode);
    }
    if (typeof onSettingChange === "function") {
      onSettingChange("gateMode", mode);
    }
  };

  const recorderRef = useRef(null);
  const timerRef = useRef(null);
  const audioPlayerRef = useRef(null);

  useEffect(() => {
    fetchProfile();
    return () => {
      cleanup();
      if (audioPlayerRef.current) audioPlayerRef.current.pause();
    };
  }, []);

  const fetchProfile = async () => {
    try {
      const [profData, statusData] = await Promise.all([
        getSpeakerProfile().catch(() => null),
        getSpeakerStatus().catch(() => null),
      ]);
      setProfile(profData);
      if (statusData?.thresholds?.user !== undefined) {
        setUserThreshold(statusData.thresholds.user);
      }
    } catch {
      // Ignore
    }
  };

  const cleanup = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.cancel();
      recorderRef.current = null;
    }
    setIsRecording(false);
    setIsTestingRecording(false);
  };

  // Recording methods
  const startRecording = async () => {
    cleanup();
    setErrorMsg("");

    try {
      const recorder = new VoiceSampleRecorder();
      recorderRef.current = recorder;
      await recorder.start();
      setIsRecording(true);
      setDuration(0);

      const start = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        setDuration(elapsed);
        if (elapsed >= 5) stopRecording();
      }, 100);
    } catch (err) {
      setErrorMsg(err.message || "Failed to access microphone.");
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current || !isRecording) return;
    try {
      if (timerRef.current) clearInterval(timerRef.current);
      setIsRecording(false);
      const res = await recorderRef.current.stop();
      recorderRef.current = null;

      if (res.durationSec < 1.0) {
        setErrorMsg("Clip too short. Please speak for at least 2 seconds.");
        return;
      }
      setRecordedSamples((prev) => [...prev, res]);
    } catch {
      setErrorMsg("Failed to encode recording.");
    }
  };

  const playSample = (idx) => {
    const sample = recordedSamples[idx];
    if (!sample?.wavUrl) return;

    if (playingIdx === idx) {
      audioPlayerRef.current?.pause();
      setPlayingIdx(null);
      return;
    }
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio();
      audioPlayerRef.current.onended = () => setPlayingIdx(null);
    }
    audioPlayerRef.current.src = sample.wavUrl;
    audioPlayerRef.current.play();
    setPlayingIdx(idx);
  };

  const deleteSample = (idx) => {
    if (playingIdx === idx) {
      audioPlayerRef.current?.pause();
      setPlayingIdx(null);
    }
    setRecordedSamples((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (recordedSamples.length === 0) return;
    setIsSaving(true);
    setErrorMsg("");
    try {
      await enrollSpeakerVoice({
        samples: recordedSamples.map((s) => s.base64Wav),
        speaker_name: "USER",
        sample_rate: 16000,
      });
      speakerVerificationService.clearEnrolledCache();
      setIsRecordingOpen(false);
      setRecordedSamples([]);
      fetchProfile();
    } catch (err) {
      setErrorMsg(err.message || "Failed to save voice profile.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (!window.confirm("Remove your enrolled voice profile?")) return;
    try {
      await deleteSpeakerProfile();
      speakerVerificationService.clearEnrolledCache();
      setRecordedSamples([]);
      setTestResult(null);
      fetchProfile();
    } catch {
      // Ignore
    }
  };

  // Test methods
  const startTestRecording = async () => {
    cleanup();
    setTestError("");
    setTestResult(null);

    try {
      const recorder = new VoiceSampleRecorder();
      recorderRef.current = recorder;
      await recorder.start();
      setIsTestingRecording(true);
      setDuration(0);

      const start = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        setDuration(elapsed);
        if (elapsed >= 3) stopTestRecording();
      }, 100);
    } catch (err) {
      setTestError(err.message || "Failed to access microphone.");
      setIsTestingRecording(false);
    }
  };

  const stopTestRecording = async () => {
    if (!recorderRef.current || !isTestingRecording) return;
    try {
      if (timerRef.current) clearInterval(timerRef.current);
      setIsTestingRecording(false);
      const res = await recorderRef.current.stop();
      recorderRef.current = null;

      const result = await verifySpeakerAudio({
        audio: res.base64Wav,
        sample_rate: 16000,
      });
      setTestResult(result);
    } catch (err) {
      setTestError(err.message || "Verification test failed.");
    }
  };

  const handleThresholdChange = async (val) => {
    setUserThreshold(val);
    try {
      await updateSpeakerThresholds({ user_threshold: val });
    } catch {
      // Ignore
    }
  };

  const isEnrolled = Boolean(profile?.enrolled);

  return (
    <>
      {/* Row 1: Speaker Identification */}
      <div className={`${SL.toggleRow} space-y-3`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div>
              <h4 className="text-sm font-medium text-neutral-200">Speaker Identification</h4>
            </div>
            <p className="text-[10px] text-neutral-500 mt-0.5">
              Recognize your voice so Rie responds only to you and ignores other voices in the room.
            </p>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${isEnrolled ? "bg-emerald-400" : "bg-neutral-500"}`} />
              <span className="text-neutral-400">
                {isEnrolled
                  ? `Enrolled (${profile.speaker || "USER"}${profile.num_samples ? ` • ${profile.num_samples} sample${profile.num_samples > 1 ? "s" : ""}` : ""})`
                  : "Not configured"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isEnrolled ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setIsTesting(!isTesting);
                    setIsRecordingOpen(false);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                >
                  {isTesting ? "Close Test" : "Test"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsRecordingOpen(!isRecordingOpen);
                    setIsTesting(false);
                    setRecordedSamples([]);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                >
                  {isRecordingOpen ? "Cancel" : "Re-record"}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteProfile}
                  className="p-1.5 rounded-lg hover:bg-red-500/10 text-neutral-400 hover:text-red-400 transition-colors"
                  title="Delete voice profile"
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIsRecordingOpen(!isRecordingOpen);
                  setIsTesting(false);
                  setRecordedSamples([]);
                }}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
              >
                {isRecordingOpen ? "Cancel" : "Record Voice"}
              </button>
            )}
          </div>
        </div>

        {/* Inline Recording Drawer */}
        {isRecordingOpen && (
          <div className="pt-3 border-t border-neutral-700/40 text-xs space-y-2.5">
            <div className="flex items-center justify-between text-neutral-300">
              <span>Speak a short sentence into your mic (e.g. &ldquo;Hey Rie, this is my voice.&rdquo;)</span>
              <span className="text-[11px] text-neutral-500">
                1 sample works; 2–3 samples (English &amp; Tamil) recommended
              </span>
            </div>

            {/* Recorded samples chips + Add / Stop buttons */}
            <div className="flex flex-wrap items-center gap-2">
              {recordedSamples.map((sample, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs"
                >
                  <span className="font-medium text-neutral-300">Sample {idx + 1} ({sample.durationSec.toFixed(1)}s)</span>
                  <button
                    type="button"
                    onClick={() => playSample(idx)}
                    className="p-0.5 text-neutral-400 hover:text-white transition-colors"
                    title={playingIdx === idx ? "Pause" : "Play"}
                  >
                    {playingIdx === idx ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSample(idx)}
                    className="p-0.5 text-neutral-500 hover:text-red-400 transition-colors"
                    title="Remove sample"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}

              {isRecording ? (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="px-3 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <Square size={11} />
                  Stop ({duration}s)
                </button>
              ) : (
                recordedSamples.length < 3 && (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700 text-xs flex items-center gap-1 transition-colors"
                  >
                    {recordedSamples.length === 0 ? (
                      <>
                        <Mic size={12} className="text-emerald-400" />
                        Start Recording
                      </>
                    ) : (
                      <>
                        <Plus size={12} />
                        Add Another Sample ({recordedSamples.length}/3)
                      </>
                    )}
                  </button>
                )
              )}

              {recordedSamples.length > 0 && !isRecording && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50 ml-auto"
                >
                  {isSaving ? "Saving..." : `Save Voice Profile (${recordedSamples.length} sample${recordedSamples.length > 1 ? "s" : ""})`}
                </button>
              )}
            </div>

            {errorMsg && <p className="text-red-400 text-[11px]">{errorMsg}</p>}
          </div>
        )}

        {/* Inline Test Drawer */}
        {isTesting && (
          <div className="pt-3 border-t border-neutral-700/40 text-xs space-y-2">
            <div className="flex items-center justify-between text-neutral-300">
              <span>Click test, speak for 2–3 seconds, then click verify.</span>
              {testResult && (
                <span className={`text-[11px] font-medium ${testResult.is_user ? "text-emerald-400" : "text-red-400"}`}>
                  {testResult.is_user
                    ? `Match (${(testResult.score * 100).toFixed(0)}%)`
                    : `Different voice (${(testResult.score * 100).toFixed(0)}%)`}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {!isTestingRecording ? (
                <button
                  type="button"
                  onClick={startTestRecording}
                  className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs flex items-center gap-1.5"
                >
                  <Mic size={13} className="text-emerald-400" />
                  Speak to Test
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopTestRecording}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium flex items-center gap-1.5"
                >
                  <Square size={12} />
                  Verify Now ({duration}s)
                </button>
              )}
            </div>

            {testError && <p className="text-red-400 text-[11px]">{testError}</p>}
          </div>
        )}
      </div>

      {/* Row 2: Voice Sensitivity */}
      <div className={`${SL.toggleRow} space-y-3`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div>
              <h4 className="text-sm font-medium text-neutral-200">Voice Sensitivity</h4>
            </div>
            <p className="text-[10px] text-neutral-500 mt-0.5">
              Sensitivity threshold for recognizing your voice vs others in the room.
            </p>
          </div>

          <div className="relative">
            <select
              value={userThreshold}
              onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
              className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
            >
              <option value={0.45}>Permissive (0.45)</option>
              <option value={0.50}>Normal / Balanced (0.50)</option>
              <option value={0.55}>Strict (0.55)</option>
              <option value={0.60}>Very Strict (0.60)</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Row 3: Audio Privacy & Streaming Policy */}
      <div className={`${SL.toggleRow} space-y-3`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div>
              <h4 className="text-sm font-medium text-neutral-200">Audio Privacy &amp; Streaming</h4>
            </div>
            <p className="text-[10px] text-neutral-500 mt-0.5">
              Control whether speech from unrecognized voices is sent to Gemini or dropped at your microphone.
            </p>
          </div>

          <div className="relative">
            <select
              value={gateMode}
              onChange={(e) => handleGateModeChange(e.target.value)}
              className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[210px]"
            >
              <option value="drop">Strict (Only send my voice)</option>
              <option value="tagger">Ambient (Listen without speaking)</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default SpeakerVoiceSettings;
