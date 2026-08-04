"use client";

import React, { useEffect, useRef, useState } from "react";
import { apiClient } from "@/services";
import SearchIcon from "@/components/Search/Icons/SearchIcon";
import { translatePluginRoleLabel } from "@/constants/roleLabels";

export type User = {
  id: number;
  username: string;
  email: string;
  phone: string;
  IsVerified: boolean;
  IsActive: boolean;
  role?: {
    id: number;
    name: string;
    description: string;
    type: string;
    createdAt?: string;
    updatedAt?: string;
  } | null;
  user_info?: {
    id: number;
    FirstName: string;
    LastName: string;
    NationalCode?: string | null;
    BirthDate?: string | null;
    Sex?: boolean | null;
    Bio?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
  user_wallet?: {
    id: number;
    Balance: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  provider?: string | null;
  confirmed?: boolean;
  blocked?: boolean;
  external_source?: string | null;
  external_id?: string | null;
  removedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  product_reviews?: any[];
  contracts?: any[];
  user_addresses?: any[];
  user_role?: null;
  cart?: {
    id: number;
    Status: string;
    createdAt: string;
    updatedAt: string;
  };
  orders?: any[];
  discounts?: any[];
};

type CustomerSearchResult = {
  id: number;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
};

interface UserSearchSectionProps {
  selectedUser: User | null;
  onUserSelect: (user: User) => void;
  showSelectedCard?: boolean;
}

const UserSearchSection: React.FC<UserSearchSectionProps> = ({
  selectedUser,
  onUserSelect,
  showSelectedCard = true,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Debounced live search
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    setActiveIndex(-1);

    const q = searchQuery.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const response = await apiClient.get<CustomerSearchResult[]>(
          `/sp/customers/search?q=${encodeURIComponent(q)}&pageSize=6`,
          {
            signal: controller.signal,
          },
        );

        if (!mounted) return;

        const users: User[] = (response.data || []).map((customer) => ({
          id: customer.id,
          username: customer.phone,
          email: "",
          phone: customer.phone,
          IsVerified: true,
          IsActive: customer.isActive,
          user_info: {
            id: customer.id,
            FirstName: customer.firstName || "",
            LastName: customer.lastName || "",
          },
        }));
        setSuggestions(users);
        setOpen(users.length > 0);
      } catch (error) {
        if (!mounted) return;
        setSuggestions([]);
        setOpen(false);
      } finally {
        if (mounted) setLoading(false);
      }
    }, 300);

    return () => {
      mounted = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [searchQuery]);

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const user = suggestions[activeIndex];
      if (user) {
        onUserSelect(user);
        setOpen(false);
        setSearchQuery("");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const handleUserSelect = (user: User) => {
    onUserSelect(user);
    setOpen(false);
    setSearchQuery("");
  };

  const getUserDisplayName = (user: User) => {
    const firstName = user.user_info?.FirstName;
    const lastName = user.user_info?.LastName;
    return firstName && lastName ? `${firstName} ${lastName}` : user.phone;
  };

  const formatPrice = (price: string | number) => {
    return new Intl.NumberFormat("fa-IR").format(Number(price));
  };

  return (
    <div className="space-y-4">
      {showSelectedCard && (
        <>
          {selectedUser ? (
            <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                  <span className="text-sm font-semibold text-green-800">
                    {getUserDisplayName(selectedUser).charAt(0)}
                  </span>
                </div>
                <div>
                  <p className="font-medium text-green-900">{getUserDisplayName(selectedUser)}</p>
                  <p className="text-sm text-green-700">{selectedUser.phone}</p>
                </div>
              </div>
              <div className="text-left">
                <p className="text-sm text-green-700">
                  موجودی: {formatPrice(selectedUser.user_wallet?.Balance || "0")} تومان
                </p>
                <button
                  onClick={() => onUserSelect(null as any)}
                  className="mt-1 text-sm text-red-600 hover:text-red-800"
                >
                  حذف
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-600">
                هیچ مشتری انتخاب نشده (اختیاری) - اطلاعات مشتری به صورت دستی وارد خواهد شد
              </p>
            </div>
          )}
        </>
      )}

      {/* Search Input */}
      <div ref={containerRef} className="relative">
        <div className="relative flex w-full items-center justify-between rounded-[28px] border border-slate-200 bg-white py-2 pl-2 pr-4 shadow-sm focus-within:ring-2 focus-within:ring-infinity-primary-lighter/60">
          <div className="flex w-full items-center justify-between px-2">
            <input
              type="text"
              name="userSearch"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => {
                setIsFocused(true);
                if (searchQuery.trim().length >= 2) setOpen(true);
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (!open) setIsFocused(false);
                }, 80);
              }}
              onKeyDown={onKeyDown}
              placeholder="جستجو مشتری با نام، نام خانوادگی یا شماره تلفن..."
              className="flex-1 bg-transparent text-right text-sm text-neutral-600 placeholder-neutral-400 outline-none"
              role="combobox"
              aria-expanded={open}
            />

            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-infinity-primary shadow-sm">
              <SearchIcon className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>

        {/* Suggestions dropdown */}
        {open && (
          <div className="absolute inset-x-0 top-full z-[1000] mt-2 max-h-96 w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white text-neutral-800 shadow-xl">
            {loading && <div className="px-3 py-2 text-xs text-neutral-500">در حال جستجو…</div>}
            {!loading && suggestions.length === 0 && (
              <div className="px-3 py-2 text-xs text-neutral-500">مشتری یافت نشد</div>
            )}
            {!loading &&
              suggestions.map((user, idx) => (
                <button
                  key={user.id}
                  onClick={() => handleUserSelect(user)}
                  className={`flex w-full items-center gap-3 border-b border-slate-100 p-4 text-right last:border-b-0 hover:bg-slate-50 ${
                    activeIndex === idx ? "bg-slate-50" : ""
                  }`}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
                    <span className="text-sm font-semibold text-slate-700">
                      {getUserDisplayName(user).charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-slate-900">{getUserDisplayName(user)}</p>
                      <span className="text-xs text-slate-500">
                        {translatePluginRoleLabel(user.role?.name)}
                      </span>
                    </div>
                    <p className="text-sm text-slate-600">{user.phone}</p>
                    {user.user_wallet?.Balance && (
                      <p className="text-xs text-slate-500">
                        موجودی: {formatPrice(user.user_wallet.Balance)} تومان
                      </p>
                    )}
                  </div>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default UserSearchSection;
