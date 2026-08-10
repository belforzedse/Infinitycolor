"use client";

import UpsertPageContentWrapper from "@/components/SuperAdmin/UpsertPage/ContentWrapper/index";
import { config } from "./config";
import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useState } from "react";
import UserService from "@/services/user";
import { updateAdminUser } from "@/services/super-admin/user/update";
import { getUserActivities, UserActivity } from "@/services/user-activity";
import Link from "next/link";
import { useCan } from "@/hooks/useCan";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WalletAdjustCard from "./WalletAdjustCard";
import {
  AdminCard,
  DetailHeader,
  EmptyState,
  ErrorState,
  ResourceDetailSkeleton,
  StatusBadge,
} from "@/components/admin";
import {
  formatBirthDateValueForStorage,
  parseStoredBirthDateToDate,
} from "@/utils/birthDate";

export type User = {
  id: string;
  firstname: string;
  lastname: string;
  phone: string;
  role: string;
  password: string;
  birthDate: Date;
  nationalCode: string;
  gender: string;
  bio: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  legacyRoleId?: string | null;
};

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const canAdjustWallet = useCan("wallet.adjust");
  const { user: currentUser } = useCurrentUser();
  const [userData, setUserData] = useState<User | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revalidate, setRevalidate] = useState(0);
  const [userActivities, setUserActivities] = useState<UserActivity[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(false);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        setIsLoading(true);
        // Fetch user data from API
        const _user = await UserService.getDetails(id);

        const userInfo = (_user.user_info || {}) as Record<string, any>;

        const formattedData: User = {
          id: _user.id.toString(),
          bio: userInfo.Bio || "",
          birthDate: parseStoredBirthDateToDate(userInfo.BirthDate),
          createdAt: _user.createdAt ? new Date(_user.createdAt) : new Date(),
          gender: userInfo.Sex ? "male" : "female",
          firstname: userInfo.FirstName || "",
          lastname: userInfo.LastName || "",
          password: "",
          phone: _user.phone || "",
          role: _user.role?.id ? _user.role.id.toString() : "",
          updatedAt: _user.updatedAt ? new Date(_user.updatedAt) : new Date(),
          nationalCode: userInfo.NationalCode || "",
          isActive: _user.IsActive ?? false,
          legacyRoleId: _user.user_role?.id
            ? _user.user_role.id.toString()
            : null,
        };

        setUserData(formattedData);
      } catch (err) {
        console.error("Error fetching user data:", err);
        setError("Failed to load user data. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };

    if (id) {
      fetchUserData();
    }
  }, [id, revalidate]);

  // Fetch user activities
  useEffect(() => {
    const fetchActivities = async () => {
      if (!id) return;
      try {
        setActivitiesLoading(true);
        const response = await getUserActivities(Number(id), {
          page: 1,
          pageSize: 20,
        });
        setUserActivities(response.data || []);
      } catch (err) {
        console.error("Error fetching user activities:", err);
      } finally {
        setActivitiesLoading(false);
      }
    };
    fetchActivities();
  }, [id]);

  if (isLoading) {
    return <ResourceDetailSkeleton />;
  }

  if (error) {
    return (
      <AdminCard padded={false}>
        <ErrorState
          description={error}
          onRetry={() => setRevalidate((p) => p + 1)}
        />
      </AdminCard>
    );
  }

  const displayName =
    `${userData?.firstname ?? ""} ${userData?.lastname ?? ""}`.trim() || null;

  return (
    <div className="space-y-4 lg:space-y-6">
      <DetailHeader
        backHref="/users"
        backLabel="بازگشت به کاربران"
        title={displayName}
        titleFallback="بدون نام"
        identifier={
          userData?.phone ? (
            <span className="text-xs text-slate-500" dir="ltr">
              {userData.phone}
            </span>
          ) : null
        }
        badge={
          userData ? (
            <StatusBadge
              label={userData.isActive ? "فعال" : "غیرفعال"}
              tone={userData.isActive ? "success" : "neutral"}
            />
          ) : null
        }
      />
      <UpsertPageContentWrapper
        config={config}
        data={userData}
        onSubmit={async (data) => {
          const birthDateString = formatBirthDateValueForStorage(
            data.birthDate,
          );

          const localPayload = {
            firstName: data.firstname,
            lastName: data.lastname,
            ...(birthDateString && { birthDate: birthDateString }),
            bio: data.bio,
            isActive: data.isActive,
            nationalCode: data.nationalCode,
            role: userData?.legacyRoleId ?? undefined,
          };

          try {
            setIsLoading(true);
            // Keep the role update last. If the signed-in Superadmin demotes
            // themselves, later privileged requests would correctly lose access.
            await updateAdminUser({
              id,
              profile: localPayload,
              user: {
                ...(data.role ? { role: Number(data.role) } : {}),
                IsActive: data.isActive,
              },
            });

            const changedOwnRole =
              Number(currentUser?.id) === Number(id) &&
              Number(userData?.role) !== Number(data.role);
            if (changedOwnRole) {
              // Reload the shell from a fresh /users/me response so stale
              // Superadmin navigation/capabilities cannot survive demotion.
              window.location.assign("/");
              return;
            }
            setRevalidate((prev) => prev + 1);
          } catch (err) {
            console.error("Failed to update user:", err);
            setError(
              (err as { message?: string })?.message ===
                "At least one active Superadmin must remain"
                ? "برای تغییر این نقش، باید حداقل یک سوپر ادمین فعال دیگر وجود داشته باشد."
                : "خطا در بروزرسانی اطلاعات کاربر",
            );
          } finally {
            setIsLoading(false);
          }
        }}
      />

      {canAdjustWallet && id && <WalletAdjustCard userId={Number(id)} />}

      {/* User Activities Section */}
      <div className="rounded-2xl bg-white p-6">
        <h2 className="mb-4 text-xl font-bold text-neutral-900">
          فعالیت‌های کاربر
        </h2>
        {activitiesLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-infinity-primary"></div>
          </div>
        ) : userActivities.length === 0 ? (
          <EmptyState title="فعالیتی ثبت نشده است" />
        ) : (
          <div className="space-y-3">
            {userActivities.map((activity) => (
              <div
                key={activity.id}
                className="rounded-lg border border-neutral-200 bg-neutral-50 p-4"
              >
                <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {activity.Icon && (
                        <span className="text-xl">{activity.Icon}</span>
                      )}
                      <h3 className="font-medium text-neutral-900">
                        {activity.Title}
                      </h3>
                    </div>
                    <p className="mt-1 min-w-0 break-words text-sm text-neutral-600">
                      {activity.Message}
                    </p>
                    <p className="mt-2 text-xs text-neutral-500">
                      {new Date(activity.createdAt).toLocaleString("fa-IR")}
                    </p>
                  </div>
                  {activity.ResourceType === "order" && activity.ResourceId && (
                    <Link
                      href={`/orders/edit/${activity.ResourceId}`}
                      className="text-sm shrink-0 text-infinity-primary hover:text-infinity-primary-dark hover:underline"
                    >
                      مشاهده سفارش
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
