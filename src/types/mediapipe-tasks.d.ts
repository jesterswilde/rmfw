declare module "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7" {
  export interface NormalizedLandmark {
    x: number;
    y: number;
    z: number;
    visibility?: number;
  }

  export interface PoseLandmarkerResult {
    poseLandmarks: NormalizedLandmark[][];
    poseWorldLandmarks: NormalizedLandmark[][];
  }

  export class FilesetResolver {
    static forVisionTasks(path: string): Promise<any>;
  }

  export class PoseLandmarker {
    static createFromOptions(resolver: any, options: any): Promise<PoseLandmarker>;
    detectForVideo(video: HTMLVideoElement, timestampMs: number): PoseLandmarkerResult;
  }

  export class DrawingUtils {
    constructor(ctx: CanvasRenderingContext2D);
    drawLandmarks(landmarks: NormalizedLandmark[], options?: { radius?: number }): void;
    drawConnectors(
      landmarks: NormalizedLandmark[],
      connectors: Array<{ start: number; end: number }> | Array<[number, number]>,
      options?: { lineWidth?: number }
    ): void;
  }
}
