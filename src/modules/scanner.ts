import ScannerWorker from '../worker?worker';
import type { MatchResult, ScanPayload } from '../modules/types';

export interface ScannerEvents {
  onProgress: (percent: number) => void;
  onComplete: (results: MatchResult[]) => void;
  onError: (error: string) => void;
}

export class ScannerService {
  private worker: Worker | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    this.worker = new ScannerWorker();
  }

  public runScan(payload: ScanPayload, events: ScannerEvents): void {
    if (!this.worker) {
      this.initWorker();
    }

    const currentWorker = this.worker!;

    currentWorker.onmessage = (event) => {
      const response = event.data;

      if (response.type === 'progress') {
        events.onProgress(response.percent);
        return;
      }

      if (response.type === 'complete') {
        if (response.success) {
          events.onComplete(response.data);
        } else {
          events.onError(response.error);
        }
      }
    };

    currentWorker.postMessage(payload, [payload.primersBuffer, payload.samplesBuffer]);
  }

  public cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.initWorker();
    }
  }
}