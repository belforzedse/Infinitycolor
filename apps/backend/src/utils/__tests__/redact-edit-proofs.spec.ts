import { redactEditProofs } from "../redact-edit-proofs";

it("redacts incoming headers and nested lease proofs while preserving diagnostic codes", () => {
  const event = { request: { headers: { "X-Product-Edit-Token": "secret", "x-product-edit-generation": "3", "user-agent": "browser" } }, extra: { lease: { token: "secret", token_hash: "hash", editorInstanceId: "tab", code: "EDIT_LEASE_LOST" } }, breadcrumbs: [{ data: { headers: { "x-product-edit-token": "secret" } } }] };
  expect(redactEditProofs(event)).toEqual({ request: { headers: { "X-Product-Edit-Token": "[Filtered]", "x-product-edit-generation": "[Filtered]", "user-agent": "browser" } }, extra: { lease: { token: "[Filtered]", token_hash: "[Filtered]", editorInstanceId: "[Filtered]", code: "EDIT_LEASE_LOST" } }, breadcrumbs: [{ data: { headers: { "x-product-edit-token": "[Filtered]" } } }] });
});
