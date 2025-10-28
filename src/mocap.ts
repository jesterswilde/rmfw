const MODEL_VERSION = "0.10.7";
const VISION_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MODEL_VERSION}`;
const WASM_ASSET_URL = `${VISION_BASE_URL}/wasm`;
const MODEL_ASSET_URL = `${WASM_ASSET_URL}/pose_landmarker_lite.task`;

type LandmarkerModule = typeof import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7");

interface RecordedKeypoint {
  name: string;
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

interface PoseFrame {
  timestamp: number;
  keypoints: RecordedKeypoint[];
  worldKeypoints?: RecordedKeypoint[];
  bounds?: BoundingBox;
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface PoseCapture {
  id: string;
  label: string;
  frames: PoseFrame[];
  createdAt: number;
  duration: number;
}

const LANDMARK_NAMES: string[] = [
  "nose",
  "left_eye_inner",
  "left_eye",
  "left_eye_outer",
  "right_eye_inner",
  "right_eye",
  "right_eye_outer",
  "left_ear",
  "right_ear",
  "mouth_left",
  "mouth_right",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_pinky",
  "right_pinky",
  "left_index",
  "right_index",
  "left_thumb",
  "right_thumb",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_foot_index",
  "right_foot_index",
];

const BODY_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [15, 17],
  [17, 19],
  [19, 21],
  [16, 18],
  [18, 20],
  [20, 22],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
  [11, 0],
  [12, 0],
  [0, 7],
  [0, 8],
];

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function computeBounds(points: RecordedKeypoint[]): BoundingBox | undefined {
  if (points.length === 0) {
    return undefined;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of points) {
    if (Number.isFinite(pt.x)) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
    }
    if (Number.isFinite(pt.y)) {
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return undefined;
  }
  return { minX, minY, maxX, maxY };
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

class MocapApp {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly poseReadout: HTMLTextAreaElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly recordButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly playbackButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly labelInput: HTMLInputElement;
  private readonly sequenceList: HTMLElement;

  private landmarkerModule: LandmarkerModule | null = null;
  private landmarker: import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7").PoseLandmarker | null = null;
  private landmarkerPromise: Promise<import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7").PoseLandmarker> | null = null;

  private stream: MediaStream | null = null;
  private animationFrame: number | null = null;
  private liveFrame: PoseFrame | null = null;

  private captures: PoseCapture[] = [];
  private activeRecording: { startTime: number; frames: PoseFrame[] } | null = null;

  private playback: { capture: PoseCapture; startTime: number; index: number; lastFrame?: PoseFrame } | null = null;

  constructor() {
    const video = document.getElementById("camera");
    const canvas = document.getElementById("overlay");
    const poseReadout = document.getElementById("pose-readout");
    const cameraButton = document.getElementById("camera-button");
    const recordButton = document.getElementById("record-button");
    const stopButton = document.getElementById("stop-button");
    const playbackButton = document.getElementById("playback-button");
    const downloadButton = document.getElementById("download-button");
    const labelInput = document.getElementById("label-input");
    const sequenceList = document.getElementById("sequence-list");

    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Camera element not found");
    }
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Overlay canvas not found");
    }
    if (!(poseReadout instanceof HTMLTextAreaElement)) {
      throw new Error("Pose readout element missing");
    }
    if (!(cameraButton instanceof HTMLButtonElement)) {
      throw new Error("Camera button missing");
    }
    if (!(recordButton instanceof HTMLButtonElement)) {
      throw new Error("Record button missing");
    }
    if (!(stopButton instanceof HTMLButtonElement)) {
      throw new Error("Stop button missing");
    }
    if (!(playbackButton instanceof HTMLButtonElement)) {
      throw new Error("Playback button missing");
    }
    if (!(downloadButton instanceof HTMLButtonElement)) {
      throw new Error("Download button missing");
    }
    if (!(labelInput instanceof HTMLInputElement)) {
      throw new Error("Label input missing");
    }
    if (!(sequenceList instanceof HTMLElement)) {
      throw new Error("Sequence list element missing");
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to acquire 2D context");
    }

    this.video = video;
    this.canvas = canvas;
    this.ctx = ctx;
    this.poseReadout = poseReadout;
    this.cameraButton = cameraButton;
    this.recordButton = recordButton;
    this.stopButton = stopButton;
    this.playbackButton = playbackButton;
    this.downloadButton = downloadButton;
    this.labelInput = labelInput;
    this.sequenceList = sequenceList;

    this.configureUi();
    this.recordButton.disabled = true;
    this.stopButton.disabled = true;
    this.playbackButton.disabled = true;
    this.downloadButton.disabled = true;
    this.renderSequenceList();
  }

  private configureUi(): void {
    this.cameraButton.addEventListener("click", () => {
      void this.initializeCameraAndModel();
    });

    this.recordButton.addEventListener("click", () => {
      this.startRecording();
    });

    this.stopButton.addEventListener("click", () => {
      if (this.activeRecording) {
        this.stopRecording();
      }
      if (this.playback) {
        this.stopPlayback();
      }
    });

    this.playbackButton.addEventListener("click", () => {
      const latest = this.captures.at(-1);
      if (latest) {
        this.playCapture(latest.id);
      }
    });

    this.downloadButton.addEventListener("click", () => {
      this.downloadCaptures();
    });

    this.sequenceList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const card = target.closest<HTMLElement>("[data-sequence-id]");
      if (!card) {
        return;
      }
      const captureId = card.dataset["sequenceId"];
      if (!captureId) {
        return;
      }

      if (target.matches("[data-action=play]")) {
        this.playCapture(captureId);
      } else if (target.matches("[data-action=delete]")) {
        this.deleteCapture(captureId);
      }
    });

    window.addEventListener("beforeunload", () => {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
      }
    });
  }

  private async initializeCameraAndModel(): Promise<void> {
    try {
      await this.startCamera();
      await this.loadLandmarker();
      this.recordButton.disabled = false;
      this.stopButton.disabled = true;
      this.cameraButton.disabled = true;
      this.playLoop();
    } catch (error) {
      console.error("Failed to initialize camera", error);
      this.poseReadout.value = `Camera error: ${String(error)}`;
    }
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is unavailable in this browser");
    }
    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
      audio: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.video.srcObject = stream;

    await new Promise<void>((resolve) => {
      this.video.onloadedmetadata = () => {
        this.updateCanvasSize();
        resolve();
      };
    });

    await this.video.play();
  }

  private async loadLandmarker(): Promise<void> {
    if (this.landmarker) {
      return;
    }
    if (!this.landmarkerPromise) {
      this.landmarkerPromise = (async () => {
        const visionModule: LandmarkerModule = await import(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7"
        );
        this.landmarkerModule = visionModule;
        const resolver = await visionModule.FilesetResolver.forVisionTasks(WASM_ASSET_URL);
        const landmarker = await visionModule.PoseLandmarker.createFromOptions(resolver, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_URL,
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        return landmarker;
      })();
    }
    this.landmarker = await this.landmarkerPromise;
  }

  private updateCanvasSize(): void {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return;
    }
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
  }

  private playLoop(): void {
    if (this.animationFrame !== null) {
      return;
    }
    const step = () => {
      this.animationFrame = window.requestAnimationFrame(step);
      void this.processFrame();
    };
    this.animationFrame = window.requestAnimationFrame(step);
  }

  private async processFrame(): Promise<void> {
    if (!this.landmarker || !this.stream) {
      return;
    }
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    this.updateCanvasSize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const now = performance.now();
    const result = this.landmarker.detectForVideo(this.video, now);
    const [landmarks] = result.poseLandmarks;
    const [worldLandmarks] = result.poseWorldLandmarks ?? [];

    if (landmarks && landmarks.length > 0) {
      this.drawLandmarks(landmarks, "#5bd7ff", 3);
      this.drawConnections(landmarks, "rgba(91, 215, 255, 0.6)", 2);

      const frame = this.buildFrame(now, landmarks, worldLandmarks);
      this.liveFrame = frame;
      this.updateReadout(frame);
      if (this.activeRecording) {
        const relativeTimestamp = now - this.activeRecording.startTime;
        this.activeRecording.frames.push({
          ...frame,
          timestamp: relativeTimestamp,
        });
      }
    } else {
      this.liveFrame = null;
      this.updateReadout(null);
    }

    this.drawPlayback(now);
  }

  private buildFrame(
    timestamp: number,
    landmarks: import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7").NormalizedLandmark[],
    worldLandmarks?: import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7").NormalizedLandmark[]
  ): PoseFrame {
    const keypoints = this.mapLandmarks(landmarks);
    const frame: PoseFrame = {
      timestamp,
      keypoints,
    };
    const bounds = computeBounds(keypoints);
    if (bounds) {
      frame.bounds = bounds;
    }
    if (worldLandmarks && worldLandmarks.length > 0) {
      frame.worldKeypoints = this.mapLandmarks(worldLandmarks);
    }
    return frame;
  }

  private mapLandmarks(
    landmarks: import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7").NormalizedLandmark[]
  ): RecordedKeypoint[] {
    return landmarks.map((landmark, index) => {
      const point: RecordedKeypoint = {
        name: LANDMARK_NAMES[index] ?? `landmark_${index}`,
        x: clamp01(landmark.x),
        y: clamp01(landmark.y),
        z: landmark.z,
      };
      if (landmark.visibility !== undefined) {
        point.visibility = landmark.visibility;
      }
      return point;
    });
  }

  private drawLandmarks(
    landmarks: Array<{ x: number; y: number; visibility?: number }>,
    color: string,
    radius: number
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    for (const landmark of landmarks) {
      if (landmark.visibility !== undefined && landmark.visibility < 0.2) {
        continue;
      }
      const { x, y } = this.toCanvasSpace(landmark.x, landmark.y);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawConnections(
    landmarks: Array<{ x: number; y: number; visibility?: number }>,
    color: string,
    width: number
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    for (const [start, end] of BODY_CONNECTIONS) {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b) {
        continue;
      }
      if (a.visibility !== undefined && a.visibility < 0.2) {
        continue;
      }
      if (b.visibility !== undefined && b.visibility < 0.2) {
        continue;
      }
      const startPoint = this.toCanvasSpace(a.x, a.y);
      const endPoint = this.toCanvasSpace(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(startPoint.x, startPoint.y);
      ctx.lineTo(endPoint.x, endPoint.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private toCanvasSpace(x: number, y: number): { x: number; y: number } {
    return {
      x: x * this.canvas.width,
      y: y * this.canvas.height,
    };
  }

  private updateReadout(frame: PoseFrame | null): void {
    if (!frame) {
      this.poseReadout.value = "No pose detected";
      return;
    }
    const { bounds, keypoints } = frame;
    const snippet = {
      timestampMs: Math.round(frame.timestamp),
      labelHint: this.labelInput.value.trim() || null,
      bounds,
      sample: keypoints.slice(0, 5),
    };
    this.poseReadout.value = JSON.stringify(snippet, null, 2);
  }

  private startRecording(): void {
    if (this.activeRecording) {
      return;
    }
    const label = this.labelInput.value.trim();
    if (!label) {
      this.labelInput.focus();
      this.poseReadout.value = "Enter a label before recording";
      return;
    }
    this.activeRecording = {
      startTime: performance.now(),
      frames: [],
    };
    this.stopPlayback();
    this.recordButton.disabled = true;
    this.recordButton.textContent = "Recording…";
    this.stopButton.disabled = false;
  }

  private stopRecording(): void {
    if (!this.activeRecording) {
      return;
    }
    const { frames } = this.activeRecording;
    this.activeRecording = null;
    this.recordButton.disabled = false;
    this.recordButton.textContent = "Start Recording";
    if (!this.playback) {
      this.stopButton.disabled = true;
    }

    if (frames.length === 0) {
      this.poseReadout.value = "No frames captured";
      return;
    }

    const label = this.labelInput.value.trim();
    const capture: PoseCapture = {
      id: shortId(),
      label,
      frames,
      createdAt: Date.now(),
      duration: frames.at(-1)?.timestamp ?? 0,
    };
    this.captures.push(capture);
    this.poseReadout.value = `Captured ${frames.length} frames (${Math.round(capture.duration)}ms)`;
    this.playbackButton.disabled = false;
    this.downloadButton.disabled = false;
    this.renderSequenceList();
  }

  private playCapture(captureId: string): void {
    const capture = this.captures.find((entry) => entry.id === captureId);
    if (!capture) {
      return;
    }
    this.stopPlayback();
    this.playback = {
      capture,
      startTime: performance.now(),
      index: 0,
    };
    const initialFrame = capture.frames[0];
    if (initialFrame) {
      this.playback.lastFrame = initialFrame;
    }
    this.playbackButton.textContent = `Playing: ${capture.label}`;
    this.stopButton.disabled = false;
  }

  private stopPlayback(): void {
    this.playback = null;
    this.playbackButton.textContent = "Play Last Capture";
    if (!this.activeRecording) {
      this.stopButton.disabled = true;
    }
  }

  private drawPlayback(now: number): void {
    if (!this.playback) {
      return;
    }
    const playback = this.playback;
    const { capture } = playback;
    const frames = capture.frames;
    if (frames.length === 0) {
      this.stopPlayback();
      return;
    }
    const elapsed = now - playback.startTime;
    while (playback.index < frames.length && frames[playback.index]!.timestamp <= elapsed) {
      playback.lastFrame = frames[playback.index]!;
      playback.index += 1;
    }
    const frame: PoseFrame = playback.lastFrame ?? frames[0]!;
    this.drawRecordedFrame(frame);

    if (elapsed > capture.duration) {
      this.stopPlayback();
    }
  }

  private drawRecordedFrame(frame: PoseFrame): void {
    this.drawConnections(frame.keypoints, "rgba(255, 196, 64, 0.6)", 2);
    this.drawLandmarks(frame.keypoints, "#ffc440", 2.5);
  }

  private deleteCapture(captureId: string): void {
    const activePlaybackId = this.playback?.capture.id;
    this.captures = this.captures.filter((entry) => entry.id !== captureId);
    if (activePlaybackId === captureId) {
      this.stopPlayback();
    }
    if (!this.captures.length) {
      this.playbackButton.disabled = true;
      this.downloadButton.disabled = true;
      if (!this.activeRecording) {
        this.stopButton.disabled = true;
      }
    }
    this.renderSequenceList();
  }

  private renderSequenceList(): void {
    if (!this.sequenceList) {
      return;
    }
    if (!this.captures.length) {
      this.sequenceList.innerHTML = "<p>No captures saved yet.</p>";
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const capture of this.captures) {
      const card = document.createElement("article");
      card.className = "sequence-card";
      card.dataset["sequenceId"] = capture.id;
      const meta = document.createElement("div");
      const durationSeconds = (capture.duration / 1000).toFixed(2);
      meta.innerHTML = `<strong>${capture.label}</strong><small>${capture.frames.length} frames · ${durationSeconds}s</small>`;
      const actions = document.createElement("div");
      actions.className = "actions";
      const playButton = document.createElement("button");
      playButton.textContent = "Play";
      playButton.setAttribute("data-action", "play");
      const deleteButton = document.createElement("button");
      deleteButton.textContent = "Delete";
      deleteButton.setAttribute("data-action", "delete");
      actions.append(playButton, deleteButton);
      card.append(meta, actions);
      fragment.append(card);
    }
    this.sequenceList.innerHTML = "";
    this.sequenceList.append(fragment);
  }

  private downloadCaptures(): void {
    if (!this.captures.length) {
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      captures: this.captures,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mocap-captures-${Date.now()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new MocapApp();
});
