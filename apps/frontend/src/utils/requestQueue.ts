/**
 * Request Queue Manager
 * Ensures cart mutations are processed sequentially to prevent race conditions
 * Executes mutations sequentially without replaying ambiguous failures.
 */

type QueuedRequest<T> = {
  id: string;
  executor: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

export class RequestQueue {
  private queue: QueuedRequest<any>[] = [];
  private isProcessing = false;
  /**
   * Add a request to the queue
   */
  async enqueue<T>(executor: () => Promise<T>, id?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id: id || `req-${Date.now()}-${Math.random()}`,
        executor,
        resolve,
        reject,
      };

      this.queue.push(request);
      this.processQueue();
    });
  }

  /**
   * Process queue sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) continue;

      try {
        const result = await request.executor();
        request.resolve(result);
      } catch (error) {
        // ApiClient rejects with a structured ApiError object. Preserve it so
        // callers can distinguish stock, auth, and recovery failures instead
        // of receiving the lossy string "[object Object]".
        request.reject(error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Get queue size (for debugging)
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Clear queue (use with caution)
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Check if currently processing
   */
  isProcessingRequest(): boolean {
    return this.isProcessing;
  }
}

// Export singleton instance
export const cartRequestQueue = new RequestQueue();
