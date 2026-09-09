import { resolveBlogCommentUserDisplayName } from "../blogCommentAuthorName";
import type { BlogComment } from "@/services/blog/blog.service";

const user = {
  id: 1,
  username: "+989121234567",
  phone: "+989121234567",
  email: "sara@example.com",
  user_info: { FirstName: "سارا", LastName: "محمدی" },
} satisfies NonNullable<BlogComment["user"]>;

describe("resolveBlogCommentUserDisplayName", () => {
  it("prefers the profile name over a stored anonymous placeholder", () => {
    expect(resolveBlogCommentUserDisplayName(user, "کاربر ناشناس")).toBe("سارا محمدی");
  });

  it("uses the phone-backed username when the profile is empty", () => {
    expect(
      resolveBlogCommentUserDisplayName({
        id: 2,
        username: "+989121234567",
        phone: "+989121234567",
      }),
    ).toBe("+989121234567");
  });

  it("does not treat the stored anonymous label as a real name", () => {
    expect(resolveBlogCommentUserDisplayName(undefined, "کاربر ناشناس")).toBe("کاربر ناشناس");
  });
});
