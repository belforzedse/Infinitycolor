begin;

set local search_path = auth, pg_catalog;

create table if not exists auth_audit_outbox (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null default current_timestamp,
  available_at timestamptz not null default current_timestamp,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists admin_session_audit_contexts (
  session_id text primary key references sessions (id) on delete cascade,
  strapi_user_id bigint not null check (strapi_user_id > 0),
  initiator_label text not null,
  initiator_role_id text,
  initiator_role_name text,
  origin text not null default 'admin_ui',
  created_at timestamptz not null default current_timestamp
);

create index if not exists auth_audit_outbox_delivery_idx
  on auth_audit_outbox (available_at, id)
  where delivered_at is null;
create index if not exists auth_audit_outbox_lease_idx
  on auth_audit_outbox (lease_until)
  where delivered_at is null;

create or replace function enqueue_admin_session_revocation_audit()
returns trigger as $$
declare
  context_row admin_session_audit_contexts%rowtype;
  stable_dedupe text;
begin
  select * into context_row
    from admin_session_audit_contexts
   where session_id = old.id;
  if not found then return old; end if;

  stable_dedupe := 'auth:session-revoked:' || substr(md5(old.id), 1, 24);
  insert into auth_audit_outbox (dedupe_key, payload, occurred_at)
  values (
    stable_dedupe,
    jsonb_build_object(
      'eventKey', 'authentication.session_revoked',
      'result', 'success',
      'actor', jsonb_build_object(
        'type', 'service_account',
        'id', 'infinity-auth',
        'label', 'Infinity Auth'
      ),
      'initiator', jsonb_strip_nulls(jsonb_build_object(
        'type', 'human',
        'id', context_row.strapi_user_id::text,
        'label', context_row.initiator_label,
        'roleId', context_row.initiator_role_id,
        'role', context_row.initiator_role_name
      )),
      'origin', context_row.origin,
      'target', jsonb_build_object(
        'type', 'administrator',
        'id', context_row.strapi_user_id::text,
        'label', context_row.initiator_label
      ),
      'reasonCode', 'SESSION_DELETED',
      'occurredAt', current_timestamp,
      'dedupeKey', stable_dedupe,
      'metadata', jsonb_build_object('sessionTag', substr(md5(old.id), 1, 16))
    ),
    current_timestamp
  ) on conflict (dedupe_key) do nothing;
  return old;
end;
$$ language plpgsql;

drop trigger if exists sessions_admin_audit_before_delete on sessions;
create trigger sessions_admin_audit_before_delete
  before delete on sessions
  for each row execute function enqueue_admin_session_revocation_audit();

grant select, insert, update, delete on auth_audit_outbox, admin_session_audit_contexts
  to infinity_auth_app;
grant usage, select on all sequences in schema auth to infinity_auth_app;
alter default privileges in schema auth grant usage, select on sequences to infinity_auth_app;

comment on table auth_audit_outbox is
  'Delivery-only outbox for sanitized canonical audit events. Never queried as history.';
comment on table admin_session_audit_contexts is
  'Minimal non-secret context identifying administrative sessions for revoke/logout auditing.';

commit;
