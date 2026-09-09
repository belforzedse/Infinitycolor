import {
  ModelApplicationError,
  validateCreateModelApplicationPayload,
} from "../services/model-application";

const valid = {
  submissionId: "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7",
  fullName: "علی رضایی",
  phone: "۰۹۱۲۱۲۳۴۵۶۷",
  email: "example@email.com",
  age: "25",
  heightCm: "175",
  city: "تهران",
  experience: "سابقه کار روی صحنه",
  sourcePath: "/",
};

describe("model application payload validation", () => {
  it("accepts the hiring form fields and canonicalizes the phone", () => {
    expect(validateCreateModelApplicationPayload(valid)).toEqual({
      submissionId: valid.submissionId,
      fullName: valid.fullName,
      phone: "+989121234567",
      email: "example@email.com",
      age: 25,
      heightCm: 175,
      city: valid.city,
      experience: valid.experience,
      sourcePath: "/",
    });
  });

  it("rejects unrecognized fields", () => {
    expect(() => validateCreateModelApplicationPayload({ ...valid, extra: "x" })).toThrow(
      expect.objectContaining<ModelApplicationError>({
        code: "MODEL_APPLICATION_UNEXPECTED_FIELD",
        status: 400,
      }),
    );
  });

  it("rejects invalid contact numbers", () => {
    expect(() => validateCreateModelApplicationPayload({ ...valid, phone: "02112345678" })).toThrow(
      expect.objectContaining<ModelApplicationError>({
        code: "MODEL_APPLICATION_PHONE_INVALID",
        status: 400,
      }),
    );
  });

  it.each(["fullName", "phone", "age"])("requires %s", (field) => {
    expect(() => validateCreateModelApplicationPayload({ ...valid, [field]: "" })).toThrow(
      expect.objectContaining<ModelApplicationError>({
        status: 400,
      }),
    );
  });

  it("rejects an oversized photo through the dedicated photo validator", async () => {
    const { validateIncomingPhoto, MAX_PHOTO_BYTES } = await import("../lib/photos");
    await expect(
      validateIncomingPhoto(
        {
          filepath: "/tmp/missing-photo.jpg",
          originalFilename: "photo.jpg",
          mimetype: "image/jpeg",
          size: MAX_PHOTO_BYTES + 1,
        },
        "photoOne",
      ),
    ).rejects.toMatchObject({
      code: "MODEL_APPLICATION_PHOTO_TOO_LARGE",
      status: 413,
    });
  });
});
