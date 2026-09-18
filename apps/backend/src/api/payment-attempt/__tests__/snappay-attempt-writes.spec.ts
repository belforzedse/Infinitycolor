import {
  mergePreviousGenerationCallback,
  mergeSnappayAttemptObservation,
  promoteIssuedSnappayGeneration,
  requeueParkedSnappayReconcile,
} from "../services/snappay-attempt-writes";

function strapiWithRaw(raw: jest.Mock) {
  return { db: { connection: { raw } } } as unknown as {
    db: { connection: { raw: jest.Mock } };
  };
}

describe("SnappPay attempt write ownership", () => {
  it("promotes an issued token only for the exact pending dispatch and lease", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 11, provider_response: {} }] });
    const strapi = strapiWithRaw(raw);

    const installed = await promoteIssuedSnappayGeneration(strapi as never, {
      attemptId: 11,
      transactionId: 44,
      contractId: 33,
      leaseVersion: 4,
      pendingSeq: 2,
      pendingTransactionId: "NEWTX12345",
      pendingCallbackNonceHash: "nonce-hash",
      paymentToken: "token",
      paymentPageUrl: "https://pay.snapp.test/start?paymentToken=token",
      callbackNonce: "abcdefghijklmnopqrstuv",
      callbackNonceHash: "nonce-hash",
      providerResponse: { tokenAttemptSeq: 2 },
      gatewayResponse: { tokenFingerprint: "fp" },
    });

    expect(installed).toEqual(expect.objectContaining({ id: 11 }));
    const [attemptSql, attemptBindings] = raw.mock.calls[0];
    expect(attemptSql).toContain("lease_version = ?");
    expect(attemptSql).toContain("provider_response->'pendingDispatch'->>'seq' = ?");
    expect(attemptSql).toContain("provider_response->'pendingDispatch'->>'transactionId' = ?");
    expect(attemptSql).toContain("provider_response->'pendingDispatch'->>'callbackNonceHash' = ?");
    expect(attemptBindings).toEqual(
      expect.arrayContaining([4, "2", "NEWTX12345", "nonce-hash"]),
    );
  });

  it("treats zero promoted rows as a failed install, not success", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [] });
    const strapi = strapiWithRaw(raw);

    await expect(
      promoteIssuedSnappayGeneration(strapi as never, {
        attemptId: 11,
        transactionId: 44,
        contractId: 33,
        leaseVersion: 1,
        pendingSeq: 1,
        pendingTransactionId: "ABC1234567",
        pendingCallbackNonceHash: "hash",
        paymentToken: "token",
        paymentPageUrl: "https://pay.snapp.test/start",
        callbackNonce: "abcdefghijklmnopqrstuv",
        callbackNonceHash: "hash",
        providerResponse: {},
        gatewayResponse: {},
      }),
    ).resolves.toBeNull();
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("refuses a late observation of another generation", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [] });
    const strapi = strapiWithRaw(raw);

    await expect(
      mergeSnappayAttemptObservation(strapi as never, {
        attemptId: 11,
        transactionId: 44,
        patch: { httpStatus: 200, providerCode: 0 },
        providerStatus: "PENDING",
        generationSeq: 1,
        generationTransactionId: "OLDOLDOLD1",
      }),
    ).resolves.toBe(false);
    const [sql, bindings] = raw.mock.calls[0];
    expect(sql).toContain("provider_response->'generation'->>'seq' = ?");
    expect(sql).toContain("provider_response->'generation'->>'transactionId' = ?");
    expect(bindings).toEqual(expect.arrayContaining(["1", "OLDOLDOLD1"]));
  });

  it("requeues a parked Unknown reconcile and only annotates queued or running work", async () => {
    const raw = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 55, retry_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 55, status: "Processing" }] });
    const strapi = strapiWithRaw(raw);
    const metadata = { callbackState: "OK", transactionId: "ABC1234567" };

    await expect(
      requeueParkedSnappayReconcile(strapi as never, {
        operationId: 55,
        attemptId: 11,
        metadata,
        nextRunAt: new Date(),
      }),
    ).resolves.toBe("requeued");
    expect(raw.mock.calls[0][0]).toContain("status = 'Unknown'");
    expect(raw.mock.calls[0][0]).toContain("next_run_at IS NULL");

    await expect(
      requeueParkedSnappayReconcile(strapi as never, {
        operationId: 55,
        attemptId: 11,
        metadata,
        nextRunAt: new Date(),
      }),
    ).resolves.toBe("running");
    expect(raw.mock.calls[2][0]).toContain("status IN ('Queued', 'Processing')");
    expect(raw.mock.calls[2][0]).not.toContain("lease_until = NULL");
  });

  it("does not let a previous-generation callback rewrite the current generation", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 11 }] });
    const strapi = strapiWithRaw(raw);

    await expect(
      mergePreviousGenerationCallback(strapi as never, {
        attemptId: 11,
        previousTransactionId: "OLDOLDOLD1",
        patch: { callbackState: "OK" },
      }),
    ).resolves.toBe(true);
    const [sql, bindings] = raw.mock.calls[0];
    expect(sql).toContain("jsonb_set(");
    expect(sql).toContain("'{previousGeneration}'");
    expect(sql).toContain("provider_response->'previousGeneration'->>'transactionId' = ?");
    expect(sql).toContain("COALESCE(provider_response->'generation'->>'transactionId', '') <> ?");
    expect(bindings).toEqual(expect.arrayContaining(["OLDOLDOLD1", "OLDOLDOLD1"]));
  });
});
