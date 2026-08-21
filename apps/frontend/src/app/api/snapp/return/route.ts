import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getStrapiServerUrl } from "@/constants/api";
import { storefrontOrigin, storefrontUrl } from "@/lib/central-auth-server";

function isAllowedRedirect(raw: string, configuredStorefrontOrigin: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const allowed = (process.env.NEXT_PUBLIC_ALLOWED_REDIRECT_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return (
      url.origin === configuredStorefrontOrigin || allowed.some((origin) => origin === url.origin)
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const body = new URLSearchParams();
    for (const key of ["transactionId", "state", "amount"]) {
      const value = form.get(key);
      if (typeof value === "string") body.set(key, value);
    }

    const apiBase = getStrapiServerUrl();
    if (!apiBase) {
      throw new Error("Strapi server URL is not defined");
    }
    const url = new URL(
      `${apiBase.replace(/\/$/, "")}/orders/snappay/callback`,
    );
    const nonce = req.nextUrl.searchParams.get("nonce");
    if (nonce) url.searchParams.set("nonce", nonce);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });

    // If backend responds with redirect, forward it
    const location = res.headers.get("location");
    if (location) {
      if (isAllowedRedirect(location, storefrontOrigin())) {
        return NextResponse.redirect(location, { status: 302 });
      }
      return NextResponse.redirect(storefrontUrl("/payment/result?resultHint=invalid_redirect"), {
        status: 302,
      });
    }

    return NextResponse.redirect(
      storefrontUrl(
        res.ok
          ? "/payment/result?resultHint=processing"
          : "/payment/result?resultHint=invalid_callback",
      ),
      { status: 302 },
    );
  } catch {
    return NextResponse.redirect(storefrontUrl("/payment/result?resultHint=callback_error"), {
      status: 302,
    });
  }
}
