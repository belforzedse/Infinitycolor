import { translateErrorMessage } from "../errorTranslations";

describe("story MIME error translations", () => {
  it("maps the legacy English video MediaType lifecycle error", () => {
    const english =
      'Story MediaType is video, but Media "clip.png" is image/png. Select a video file for Media, and use Thumbnail for the image preview.';

    expect(translateErrorMessage(english)).toBe(
      "نوع رسانه ویدیو است اما فایل انتخاب‌شده ویدیو نیست. یک فایل ویدیو برای رسانه انتخاب کنید و از تصویر جلد برای پیش‌نمایش استفاده کنید. دوباره تلاش کنید.",
    );
  });

  it("maps the legacy English image MediaType lifecycle error", () => {
    const english =
      'Story MediaType is image, but Media "clip.mp4" is video/mp4. Select an image file for Media.';

    expect(translateErrorMessage(english)).toBe(
      "نوع رسانه تصویر است اما فایل انتخاب‌شده تصویر نیست. یک فایل تصویر برای رسانه انتخاب کنید. دوباره تلاش کنید.",
    );
  });
});
