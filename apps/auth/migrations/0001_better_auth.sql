-- Generated from Better Auth/runtime CLI 1.6.23 on 2026-08-01, then reviewed and
-- extended with the immutable Strapi link and one-time return-grant tables.
-- This migration is additive. Applying it is an explicit staging/production gate.

begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'infinity_auth_app') then
    create role infinity_auth_app
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  end if;
end
$$;

create schema auth;
revoke all on schema auth from public;
grant usage on schema auth to infinity_auth_app;

set local search_path = auth, pg_catalog;

create table users (
  id text not null primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null,
  image text,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz default current_timestamp not null
);

create table sessions (
  id text not null primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references users (id) on delete cascade
);

create table accounts (
  id text not null primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references users (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz not null
);

create table verifications (
  id text not null primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz default current_timestamp not null
);

create table jwks (
  id text not null primary key,
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null,
  expires_at timestamptz
);

create table strapi_identity_links (
  better_auth_user_id text primary key references users (id) on delete cascade,
  strapi_user_id bigint not null unique check (strapi_user_id > 0),
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz default current_timestamp not null
);

create table return_grants (
  grant_hash text primary key,
  session_id text not null references sessions (id) on delete cascade,
  return_to text not null,
  expires_at timestamptz not null,
  created_at timestamptz default current_timestamp not null
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);
create index accounts_user_id_idx on accounts (user_id);
create index verifications_identifier_idx on verifications (identifier);
create index return_grants_expires_at_idx on return_grants (expires_at);

grant select, insert, update, delete on all tables in schema auth to infinity_auth_app;
alter default privileges in schema auth
  grant select, insert, update, delete on tables to infinity_auth_app;

comment on table strapi_identity_links is
  'Immutable mapping from a Better Auth identity to the authoritative numeric Strapi user ID.';
comment on table return_grants is
  'Hashed, one-time, 60-second grants used only for server-side storefront callbacks.';

commit;
