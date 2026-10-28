import { apiClient } from "@/services";
import type { ApiRequestOptions, ApiResponse } from "@/types/api";
import type { ProductDataResponse } from "./get";

export type ProductEditSnapshot = {
  product: { id: number; attributes: ProductDataResponse };
  revision: number;
};
export type ProductEditLeaseStatus = {
  owner: { id: number; label: string } | null;
  generation: number;
  expiresAt: string | null;
  serverNow: string;
  owned: boolean;
  leaseSeconds: number;
  heartbeatSeconds: number;
  pollSeconds: number;
};
type LeaseProof = {
  token: string;
  generation: number;
  editorInstanceId: string;
  expiresAt: string;
  serverNow: string;
};
type Acquisition = { lease: LeaseProof; snapshot: ProductEditSnapshot };
export type EditorPhase = "loading" | "readonly" | "editing" | "frozen";
export type ProductEditorState = {
  phase: EditorPhase;
  status: ProductEditLeaseStatus | null;
  reason?: string;
  busy: boolean;
  snapshotEpoch: number;
};
export type ProductEditorAcquireResult = {
  outcome: "acquired" | "conflict" | "failed" | "disposed";
  status?: ProductEditLeaseStatus;
};
export type ProductEditorClient = Pick<
  typeof apiClient,
  "get" | "post" | "put" | "delete"
>;

export function productEditErrorCode(error: unknown): string | undefined {
  const e = error as {
    errorCode?: string;
    details?: { code?: string };
    data?: { errorCode?: string };
  };
  return e?.details?.code || e?.errorCode || e?.data?.errorCode;
}

/** One tab/mount owns one in-memory proof. It is never stored in browser storage. */
export class ProductEditorSession {
  readonly editorInstanceId = crypto.randomUUID();
  readonly drafts = new Map<string, unknown>();
  snapshot: ProductEditSnapshot | null = null;
  state: ProductEditorState = {
    phase: "loading",
    status: null,
    busy: false,
    snapshotEpoch: 0,
  };
  private proof: LeaseProof | null = null;
  private revision: number | null = null;
  private expiresAt = 0;
  private nextHeartbeatAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private opening = false;

  constructor(
    readonly productId: string | number,
    private install: (snapshot: ProductEditSnapshot) => void,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private publish(patch: Partial<ProductEditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private stopTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = this.expiryTimer = null;
  }
  freeze(reason = "ویرایش متوقف شد. تغییرات شما در این صفحه محفوظ است.") {
    this.stopTimers();
    this.publish({ phase: "frozen", reason });
  }
  private installSnapshot(snapshot: ProductEditSnapshot) {
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      !snapshot.product?.attributes
    ) {
      throw new Error("Invalid product edit snapshot");
    }
    this.snapshot = snapshot;
    this.revision = snapshot.revision;
    this.drafts.clear();
    this.install(snapshot);
    this.publish({ snapshotEpoch: this.state.snapshotEpoch + 1 });
  }
  private setExpiry(lease: Pick<LeaseProof, "expiresAt" | "serverNow">) {
    // Use the server's remaining duration; the operator's clock may differ.
    this.expiresAt =
      Date.now() +
      Math.max(0, Date.parse(lease.expiresAt) - Date.parse(lease.serverNow));
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.freeze("مهلت ویرایش تمام شد. تغییرات شما محفوظ است."),
      Math.max(0, this.expiresAt - Date.now()),
    );
  }
  private schedule() {
    if (this.disposed || this.state.phase === "frozen") return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = this.state.status?.pollSeconds || 10;
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
  }
  private async tick() {
    try {
      if (this.state.phase === "editing") {
        const status = await this.readStatus();
        if (this.disposed || this.state.phase !== "editing") return;
        if (!status.owned || status.generation !== this.proof?.generation) {
          this.freeze(
            "ویرایش این محصول در اختیار کاربر دیگری است. تغییرات شما محفوظ است.",
          );
          return;
        }
        if (Date.now() >= this.nextHeartbeatAt) {
          const response = await apiClient.post<{
            lease: Omit<LeaseProof, "token">;
          }>(
            `/products/${this.productId}/edit-lease/renew`,
            {},
            { retries: 0, headers: this.headers(false) },
          );
          if (this.disposed || this.state.phase !== "editing") return;
          this.setExpiry(response.data.lease);
          this.nextHeartbeatAt =
            Date.now() + (status.heartbeatSeconds || 30) * 1000;
        }
      } else if (this.state.phase === "readonly") {
        await this.readStatus();
      }
      this.schedule();
    } catch {
      if (!this.disposed && this.state.phase === "editing") {
        this.freeze(
          "ارتباط برای ادامه ویرایش تأیید نشد. تغییرات شما محفوظ است.",
        );
      } else this.schedule();
    }
  }
  async readStatus() {
    const response = await apiClient.get<ProductEditLeaseStatus>(
      `/products/${this.productId}/edit-lease`,
      {
        cache: "no-store",
        retries: 0,
        ...(this.proof ? { headers: this.headers(false) } : {}),
      },
    );
    if (!this.disposed) this.publish({ status: response.data });
    return response.data;
  }
  async open(canEdit: boolean) {
    if (this.opening || this.disposed) return;
    this.opening = true;
    try {
      const [snapshot, status] = await Promise.all([
        apiClient.get<ProductEditSnapshot>(
          `/products/${this.productId}/edit-snapshot`,
          { cache: "no-store", retries: 0 },
        ),
        this.readStatus(),
      ]);
      if (this.disposed) return;
      this.installSnapshot(snapshot.data);
      if (canEdit && !status.owner) await this.acquire();
      else {
        this.publish({ phase: "readonly" });
        this.schedule();
      }
    } catch {
      if (!this.disposed)
        this.freeze("اطلاعات محصول دریافت نشد. دوباره بارگذاری کنید.");
    } finally {
      this.opening = false;
    }
  }
  async acquire(
    takeover = false,
    expectedGeneration?: number,
  ): Promise<ProductEditorAcquireResult> {
    if (this.disposed) return { outcome: "disposed" };
    if (this.state.busy) return { outcome: "failed" };
    if (takeover && !Number.isSafeInteger(expectedGeneration))
      return { outcome: "failed" };
    this.publish({ busy: true });
    let result: ProductEditorAcquireResult = { outcome: "failed" };
    try {
      const response = await apiClient.post<Acquisition>(
        `/products/${this.productId}/edit-lease/${takeover ? "takeover" : "acquire"}`,
        {
          editorInstanceId: this.editorInstanceId,
          ...(takeover ? { expectedGeneration } : {}),
        },
        { retries: 0 },
      );
      if (this.disposed) {
        this.proof = response.data.lease;
        await this.release();
        return { outcome: "disposed" };
      }
      // A fresh snapshot must replace every old draft before proof can be used.
      this.installSnapshot(response.data.snapshot);
      this.proof = response.data.lease;
      this.setExpiry(this.proof);
      this.nextHeartbeatAt =
        Date.now() + (this.state.status?.heartbeatSeconds || 30) * 1000;
      this.publish({ phase: "editing", reason: undefined });
      this.schedule();
      result = { outcome: "acquired" };
    } catch (error) {
      if (!this.disposed) {
        const conflict = productEditErrorCode(error) === "EDIT_LEASE_CONFLICT";
        this.publish({
          phase: "readonly",
          reason:
            productEditErrorCode(error) === "EDIT_TAKEOVER_FORBIDDEN"
              ? "اجازه گرفتن ویرایش این محصول را ندارید."
              : "شروع ویرایش انجام نشد. وضعیت ویرایش را دوباره بررسی کنید.",
        });
        const status = await this.readStatus().catch(() => undefined);
        this.schedule();
        result = {
          outcome: conflict ? "conflict" : "failed",
          ...(status ? { status } : {}),
        };
      }
    } finally {
      if (!this.disposed) this.publish({ busy: false });
    }
    return result;
  }
  private headers(withRevision = true): Record<string, string> {
    if (!this.proof) throw new Error("Product edit proof unavailable");
    return {
      "X-Product-Edit-Token": this.proof.token,
      "X-Product-Edit-Instance": this.proof.editorInstanceId,
      "X-Product-Edit-Generation": String(this.proof.generation),
      ...(withRevision
        ? { "X-Product-Expected-Revision": String(this.revision) }
        : {}),
    };
  }
  /** Checks ownership again when the queued operation actually starts. */
  mutate<T>(
    operation: (options: ApiRequestOptions) => Promise<ApiResponse<T>>,
  ): Promise<ApiResponse<T>> {
    const run = this.queue.then(async () => {
      if (
        this.disposed ||
        this.state.phase !== "editing" ||
        Date.now() >= this.expiresAt
      ) {
        if (this.state.phase === "editing") this.freeze();
        throw {
          status: 409,
          errorCode: "EDIT_LEASE_LOST",
          message: "ویرایش این صفحه متوقف شده است",
        };
      }
      this.publish({ busy: true });
      try {
        const response = await operation({
          retries: 0,
          headers: this.headers(),
        });
        const committedRevision = (
          response.meta as { editRevision?: number } | undefined
        )?.editRevision;
        if (
          !Number.isSafeInteger(committedRevision) ||
          committedRevision! < this.revision!
        ) {
          this.freeze(
            "نتیجه ذخیره تأیید نشد. پیش از ادامه، محصول را دوباره بارگذاری کنید.",
          );
          throw {
            status: 0,
            errorCode: "EDIT_RESULT_UNCERTAIN",
            message: "نتیجه ذخیره تأیید نشد",
          };
        }
        this.revision = committedRevision!;
        return response;
      } catch (error) {
        const e = error as {
          status?: number;
          diagnostics?: { httpStatus?: number };
        };
        const code = productEditErrorCode(error);
        if (
          !e?.status ||
          e.status >= 500 ||
          e.status === 401 ||
          code?.startsWith("EDIT_") ||
          code?.includes("VERSION_CONFLICT")
        ) {
          this.freeze(
            code === "PRODUCT_STOCK_VERSION_CONFLICT"
              ? "موجودی تغییر کرده است. تغییرات شما محفوظ است؛ محصول را دوباره بارگذاری کنید."
              : "ادامه ویرایش تأیید نشد. تغییرات شما در این صفحه محفوظ است.",
          );
        }
        throw error;
      } finally {
        if (!this.disposed) this.publish({ busy: false });
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async release() {
    this.stopTimers();
    if (!this.disposed && this.state.phase === "editing")
      this.freeze(
        "ویرایش پایان یافت. برای ادامه، محصول را دوباره بارگذاری کنید.",
      );
    const proof = this.proof;
    this.proof = null;
    if (!proof) return;
    const headers = {
      "X-Product-Edit-Token": proof.token,
      "X-Product-Edit-Instance": proof.editorInstanceId,
      "X-Product-Edit-Generation": String(proof.generation),
    };
    await apiClient
      .post(
        `/products/${this.productId}/edit-lease/release`,
        {},
        { headers, retries: 0 },
      )
      .catch(() => undefined);
  }
  dispose() {
    this.disposed = true;
    void this.release();
    this.listeners.clear();
  }
  /** Product-scoped client; shared taxonomy reads/writes use the ordinary client. */
  readonly client: ProductEditorClient = {
    get: <T>(url: string, options?: ApiRequestOptions) =>
      apiClient.get<T>(url, options),
    post: <T>(url: string, data?: unknown, options?: ApiRequestOptions) =>
      this.mutate<T>((proof) =>
        apiClient.post<T>(url, data, {
          ...options,
          ...proof,
          headers: { ...options?.headers, ...proof.headers },
        }),
      ),
    put: <T>(url: string, data?: unknown, options?: ApiRequestOptions) =>
      this.mutate<T>((proof) =>
        apiClient.put<T>(url, data, {
          ...options,
          ...proof,
          headers: { ...options?.headers, ...proof.headers },
        }),
      ),
    delete: <T>(url: string, options?: ApiRequestOptions) =>
      this.mutate<T>((proof) =>
        apiClient.delete<T>(url, {
          ...options,
          ...proof,
          headers: { ...options?.headers, ...proof.headers },
        }),
      ),
  };
}
