-- Run this whole file in Supabase SQL Editor.
-- It creates the database schema and RPC API used by the static GitHub Pages frontend.

create extension if not exists pgcrypto;

create table if not exists app_settings (
  key text primary key,
  value text not null
);

create table if not exists classes (
  id text primary key default ('c' || extract(epoch from clock_timestamp())::bigint || floor(random() * 100000)::int),
  name text not null,
  archived boolean not null default false,
  sessions text[] not null default array['S1', 'S2', 'C', '57', 'T'],
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  class_id text not null references classes(id) on delete cascade,
  student_name text not null,
  name_key text not null,
  dob date not null,
  busy_slots text[] not null default '{}',
  status text not null check (status in ('pending', 'approved')),
  updated_at timestamptz not null default now(),
  unique (class_id, name_key, dob)
);

alter table app_settings enable row level security;
alter table classes enable row level security;
alter table submissions enable row level security;

drop policy if exists "deny direct app_settings" on app_settings;
drop policy if exists "deny direct classes" on classes;
drop policy if exists "deny direct submissions" on submissions;
create policy "deny direct app_settings" on app_settings for all using (false) with check (false);
create policy "deny direct classes" on classes for all using (false) with check (false);
create policy "deny direct submissions" on submissions for all using (false) with check (false);

insert into app_settings (key, value) values
  ('STUDENT_KEY', 'CHANGE_STUDENT_KEY'),
  ('TEACHER_KEY', 'CHANGE_TEACHER_KEY'),
  ('TEACHER_USERNAME', 'CHANGE_TEACHER_USERNAME'),
  ('TEACHER_PASSWORD', 'CHANGE_TEACHER_PASSWORD'),
  ('TEACHER_NAME', 'CHANGE_TEACHER_NAME')
on conflict (key) do nothing;

insert into classes (id, name, archived, sessions) values
  ('c1', 'F12', false, array['S1', 'S2', 'C', '57', 'T']),
  ('c2', 'F13', false, array['S1', 'S2', 'C', '57', 'T']),
  ('c3', 'F14', false, array['S1', 'S2', 'C', '57', 'T'])
on conflict (id) do nothing;

create or replace function clean_name(value text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(coalesce(value, ''), '\s+', ' ', 'g'));
$$;

create or replace function name_key(value text)
returns text
language sql
immutable
as $$
  select lower(clean_name(value));
$$;

create or replace function setting_value(setting_key text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select value from app_settings where key = setting_key;
$$;

create or replace function require_student(student_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(setting_value('STUDENT_KEY'), '') <> coalesce(student_key, '') then
    raise exception 'Không có quyền';
  end if;
end;
$$;

create or replace function require_teacher(teacher_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(setting_value('TEACHER_KEY'), '') <> coalesce(teacher_key, '') then
    raise exception 'Không có quyền';
  end if;
end;
$$;

create or replace function dob_note(value date)
returns text
language sql
immutable
as $$
  select to_char(value, 'DD/MM');
$$;

create or replace function class_summary(c classes)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'approvedCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'approved'),
    'pendingCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'pending')
  );
$$;

create or replace function api_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'days', jsonb_build_array('Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'),
    'daysShort', jsonb_build_array('T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'),
    'sessions', jsonb_build_array('S1', 'S2', 'C', '57', 'T'),
    'sessionsFull', jsonb_build_array('S1', 'S2', 'C', '57', 'T')
  );
$$;

create or replace function api_login(username text, password text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if username <> setting_value('TEACHER_USERNAME') or password <> setting_value('TEACHER_PASSWORD') then
    raise exception 'Sai tài khoản hoặc mật khẩu';
  end if;
  return jsonb_build_object('ok', true, 'name', setting_value('TEACHER_NAME'));
end;
$$;

create or replace function api_classes(student_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_student(student_key);
  return coalesce((select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id) from classes c where not c.archived), '[]'::jsonb);
end;
$$;

create or replace function api_archived_classes(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  return coalesce((select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id) from classes c where c.archived), '[]'::jsonb);
end;
$$;

create or replace function teacher_submission_json(s submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'studentName', s.student_name,
    'dob', s.dob::text,
    'busySlots', s.busy_slots,
    'status', s.status
  );
$$;

create or replace function api_class(teacher_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
begin
  perform require_teacher(teacher_key);
  select * into c from classes where id = class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'archived', c.archived,
    'sessions', c.sessions,
    'submissions', coalesce((select jsonb_agg(teacher_submission_json(s) order by lower(s.student_name), s.student_name, s.dob) from submissions s where s.class_id = c.id), '[]'::jsonb)
  );
end;
$$;

create or replace function api_student_class(student_key text, class_id text, student_name text, dob date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
  target_key text := name_key(student_name);
begin
  perform require_student(student_key);
  if target_key = '' or dob is null then raise exception 'Nhập họ tên và ngày sinh để tra cứu'; end if;
  select * into c from classes where id = class_id and not archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'canRequestChange', exists (
      select 1 from submissions s
      where s.class_id = c.id and s.status = 'approved' and s.name_key = target_key and s.dob = api_student_class.dob
    ),
    'submissions', coalesce((
      with approved as (
        select s.*, count(*) over (partition by s.name_key) as same_name_count
        from submissions s
        where s.class_id = c.id and s.status = 'approved'
      )
      select jsonb_agg(jsonb_build_object(
        'studentName', a.student_name,
        'displayName', case when a.same_name_count >= 2 then a.student_name || ' (' || dob_note(a.dob) || ')' else a.student_name end,
        'busySlots', a.busy_slots,
        'status', a.status,
        'canEdit', a.name_key = target_key and a.dob = api_student_class.dob
      ) order by lower(a.student_name), a.student_name, a.dob)
      from approved a
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function api_add_class(teacher_key text, name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id text := 'c' || extract(epoch from clock_timestamp())::bigint || floor(random() * 100000)::int;
begin
  perform require_teacher(teacher_key);
  if clean_name(name) = '' then raise exception 'Thiếu tên lớp'; end if;
  insert into classes (id, name) values (new_id, clean_name(name));
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

create or replace function api_set_class_sessions(teacher_key text, class_id text, sessions text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text[];
begin
  perform require_teacher(teacher_key);
  select array_agg(session_name order by first_seen) into cleaned
  from (
    select clean_name(x) as session_name, min(ord) as first_seen
    from unnest(sessions) with ordinality as t(x, ord)
    where clean_name(x) <> ''
    group by lower(clean_name(x)), clean_name(x)
  ) ordered_sessions;
  if cleaned is null or array_length(cleaned, 1) is null then raise exception 'Cần ít nhất 1 buổi'; end if;
  update classes set sessions = cleaned where id = class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true, 'sessions', cleaned);
end;
$$;

create or replace function api_set_archived(teacher_key text, class_id text, archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  update classes set archived = api_set_archived.archived where id = class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_delete_class(teacher_key text, class_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  delete from classes where id = class_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_clear_archived(teacher_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  delete from classes where archived;
  return jsonb_build_object('ok', true);
end;
$$;

drop function if exists upsert_submission(text, text, date, text[], text);

create or replace function upsert_submission(p_class_id text, p_student_name text, p_dob date, p_busy_slots text[], p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := clean_name(p_student_name);
begin
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if p_dob is null then raise exception 'Thiếu ngày sinh'; end if;
  insert into submissions (class_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (p_class_id, clean, name_key(clean), p_dob, coalesce(p_busy_slots, '{}'), p_status, now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_name = excluded.student_name, busy_slots = excluded.busy_slots, status = excluded.status, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_submit(student_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_student(student_key);
  if exists (select 1 from submissions s where s.class_id = api_submit.class_id and s.name_key = name_key(api_submit.student_name) and s.dob = api_submit.dob) then
    raise exception 'Học sinh này đã có trong lớp. Hãy dùng Tra cứu lịch lớp để yêu cầu đổi.';
  end if;
  return upsert_submission(api_submit.class_id, api_submit.student_name, api_submit.dob, api_submit.busy_slots, 'pending');
end;
$$;

create or replace function api_request_change(student_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_student(student_key);
  if not exists (select 1 from submissions s where s.class_id = api_request_change.class_id and s.name_key = name_key(api_request_change.student_name) and s.dob = api_request_change.dob and s.status = 'approved') then
    raise exception 'Không tìm thấy học sinh khớp họ tên và ngày sinh';
  end if;
  return upsert_submission(api_request_change.class_id, api_request_change.student_name, api_request_change.dob, api_request_change.busy_slots, 'pending');
end;
$$;

create or replace function api_add_student(teacher_key text, class_id text, student_name text, dob date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := clean_name(api_add_student.student_name);
begin
  perform require_teacher(teacher_key);
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if api_add_student.dob is null then raise exception 'Thiếu ngày sinh'; end if;
  insert into submissions (class_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (api_add_student.class_id, clean, name_key(clean), api_add_student.dob, '{}', 'approved', now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_name = excluded.student_name, status = 'approved', updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_set_submission_status(teacher_key text, class_id text, student_name text, dob date, status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  update submissions
  set student_name = clean_name(api_set_submission_status.student_name), name_key = name_key(api_set_submission_status.student_name), status = api_set_submission_status.status, updated_at = now()
  where submissions.class_id = api_set_submission_status.class_id
    and submissions.name_key = name_key(api_set_submission_status.student_name)
    and submissions.dob = api_set_submission_status.dob;
  if not found then raise exception 'Không tìm thấy đăng ký'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_delete_submission(teacher_key text, class_id text, student_name text, dob date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  delete from submissions
  where submissions.class_id = api_delete_submission.class_id
    and submissions.name_key = name_key(api_delete_submission.student_name)
    and submissions.dob = api_delete_submission.dob;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_update_busy(teacher_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  update submissions
  set busy_slots = coalesce(api_update_busy.busy_slots, '{}'), updated_at = now()
  where submissions.class_id = api_update_busy.class_id
    and submissions.name_key = name_key(api_update_busy.student_name)
    and submissions.dob = api_update_busy.dob;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_bulk_update_busy(teacher_key text, class_id text, updates jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  count_updated int := 0;
begin
  perform require_teacher(teacher_key);
  for item in select * from jsonb_array_elements(coalesce(updates, '[]'::jsonb)) loop
    update submissions
    set busy_slots = coalesce(array(select jsonb_array_elements_text(item->'busySlots')), '{}'), updated_at = now()
    where submissions.class_id = api_bulk_update_busy.class_id
      and submissions.name_key = name_key(item->>'studentName')
      and submissions.dob = (item->>'dob')::date;
    if found then count_updated := count_updated + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'count', count_updated);
end;
$$;

grant execute on all functions in schema public to anon;

-- Teacher accounts, class assignments and current class schedule.
-- This section is also safe to run as a migration on an existing database.
alter table classes add column if not exists current_slots text[] not null default '{}';

create table if not exists teacher_accounts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  username text not null,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists teacher_accounts_username_key
  on teacher_accounts (lower(username));

create table if not exists teacher_class_assignments (
  teacher_id uuid not null references teacher_accounts(id) on delete cascade,
  class_id text not null references classes(id) on delete cascade,
  primary key (teacher_id, class_id)
);

create table if not exists teacher_sessions (
  token_hash text primary key,
  role text not null check (role in ('owner', 'teacher')),
  teacher_id uuid references teacher_accounts(id) on delete cascade,
  display_name text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table teacher_accounts enable row level security;
alter table teacher_class_assignments enable row level security;
alter table teacher_sessions enable row level security;

drop policy if exists "deny direct teacher_accounts" on teacher_accounts;
drop policy if exists "deny direct teacher_class_assignments" on teacher_class_assignments;
drop policy if exists "deny direct teacher_sessions" on teacher_sessions;
create policy "deny direct teacher_accounts" on teacher_accounts for all using (false) with check (false);
create policy "deny direct teacher_class_assignments" on teacher_class_assignments for all using (false) with check (false);
create policy "deny direct teacher_sessions" on teacher_sessions for all using (false) with check (false);

create or replace function session_role(session_token text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.role
  from teacher_sessions s
  where s.token_hash = encode(extensions.digest(coalesce(session_token, ''), 'sha256'), 'hex')
    and s.expires_at > now();
$$;

create or replace function session_teacher_id(session_token text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.teacher_id
  from teacher_sessions s
  where s.token_hash = encode(extensions.digest(coalesce(session_token, ''), 'sha256'), 'hex')
    and s.expires_at > now();
$$;

create or replace function require_teacher(teacher_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(session_role(teacher_key), '') not in ('owner', 'teacher') then
    raise exception 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.';
  end if;
end;
$$;

create or replace function require_owner(teacher_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(session_role(teacher_key), '') <> 'owner' then
    raise exception 'Chỉ tài khoản owner được thực hiện thao tác này';
  end if;
end;
$$;

create or replace function can_access_class(teacher_key text, target_class_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case session_role(teacher_key)
    when 'owner' then exists (select 1 from classes c where c.id = target_class_id)
    when 'teacher' then exists (
      select 1 from teacher_class_assignments a
      where a.teacher_id = session_teacher_id(teacher_key) and a.class_id = target_class_id
    )
    else false
  end;
$$;

create or replace function api_login(username text, password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  account teacher_accounts;
  login_role text;
  login_name text;
  login_teacher_id uuid;
  raw_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if api_login.username = setting_value('TEACHER_USERNAME')
     and api_login.password = setting_value('TEACHER_PASSWORD') then
    login_role := 'owner';
    login_name := setting_value('TEACHER_NAME');
  else
    select * into account
    from teacher_accounts a
    where lower(a.username) = lower(clean_name(api_login.username)) and a.active;

    if not found or account.password_hash <> extensions.crypt(api_login.password, account.password_hash) then
      raise exception 'Sai tài khoản hoặc mật khẩu';
    end if;
    login_role := 'teacher';
    login_name := account.display_name;
    login_teacher_id := account.id;
  end if;

  delete from teacher_sessions where expires_at <= now();
  insert into teacher_sessions (token_hash, role, teacher_id, display_name, expires_at)
  values (encode(extensions.digest(raw_token, 'sha256'), 'hex'), login_role, login_teacher_id, login_name, now() + interval '30 days');

  return jsonb_build_object('ok', true, 'name', login_name, 'role', login_role, 'token', raw_token);
end;
$$;

create or replace function class_summary(c classes)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', c.current_slots,
    'approvedCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'approved'),
    'pendingCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'pending')
  );
$$;

create or replace function api_teacher_classes(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  return coalesce((
    select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id)
    from classes c
    where not c.archived and (
      session_role(teacher_key) = 'owner'
      or exists (
        select 1 from teacher_class_assignments a
        where a.teacher_id = session_teacher_id(teacher_key) and a.class_id = c.id
      )
    )
  ), '[]'::jsonb);
end;
$$;

create or replace function api_class(teacher_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
begin
  perform require_teacher(teacher_key);
  if not can_access_class(teacher_key, api_class.class_id) then raise exception 'Không có quyền xem lớp này'; end if;
  select * into c from classes where id = api_class.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'archived', c.archived,
    'sessions', c.sessions,
    'currentSlots', c.current_slots,
    'submissions', coalesce((select jsonb_agg(teacher_submission_json(s) order by lower(s.student_name), s.student_name, s.dob) from submissions s where s.class_id = c.id), '[]'::jsonb)
  );
end;
$$;

create or replace function api_student_class(student_key text, class_id text, student_name text, dob date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
  target_key text := name_key(student_name);
begin
  perform require_student(student_key);
  if target_key = '' or dob is null then raise exception 'Nhập họ tên và ngày sinh để tra cứu'; end if;
  select * into c from classes where id = api_student_class.class_id and not archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', c.current_slots,
    'canRequestChange', exists (
      select 1 from submissions s
      where s.class_id = c.id and s.status = 'approved' and s.name_key = target_key and s.dob = api_student_class.dob
    ),
    'submissions', coalesce((
      with approved as (
        select s.*, count(*) over (partition by s.name_key) as same_name_count
        from submissions s where s.class_id = c.id and s.status = 'approved'
      )
      select jsonb_agg(jsonb_build_object(
        'studentName', a.student_name,
        'displayName', case when a.same_name_count >= 2 then a.student_name || ' (' || dob_note(a.dob) || ')' else a.student_name end,
        'busySlots', a.busy_slots,
        'status', a.status,
        'canEdit', a.name_key = target_key and a.dob = api_student_class.dob
      ) order by lower(a.student_name), a.student_name, a.dob)
      from approved a
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function api_set_current_slots(teacher_key text, class_id text, current_slots text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes;
  cleaned text[];
begin
  perform require_owner(teacher_key);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) as slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid_slots;

  update classes set current_slots = cleaned where id = c.id;
  return jsonb_build_object('ok', true, 'currentSlots', cleaned);
end;
$$;

create or replace function api_add_class(teacher_key text, name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare new_id text := 'c' || extract(epoch from clock_timestamp())::bigint || floor(random() * 100000)::int;
begin
  perform require_owner(teacher_key);
  if clean_name(name) = '' then raise exception 'Thiếu tên lớp'; end if;
  insert into classes (id, name) values (new_id, clean_name(name));
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

create or replace function api_set_class_sessions(teacher_key text, class_id text, sessions text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare cleaned text[];
begin
  perform require_owner(teacher_key);
  select array_agg(session_name order by first_seen) into cleaned
  from (
    select clean_name(x) as session_name, min(ord) as first_seen
    from unnest(sessions) with ordinality as t(x, ord)
    where clean_name(x) <> ''
    group by lower(clean_name(x)), clean_name(x)
  ) ordered_sessions;
  if cleaned is null or array_length(cleaned, 1) is null then raise exception 'Cần ít nhất 1 buổi'; end if;
  update classes set sessions = cleaned, current_slots = '{}' where id = api_set_class_sessions.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true, 'sessions', cleaned);
end;
$$;

create or replace function upsert_submission(p_class_id text, p_student_name text, p_dob date, p_busy_slots text[], p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := clean_name(p_student_name);
  allowed_busy text[];
begin
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if p_dob is null then raise exception 'Thiếu ngày sinh'; end if;
  select array(select unnest(coalesce(p_busy_slots, '{}')) except select unnest(c.current_slots))
    into allowed_busy from classes c where c.id = p_class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  insert into submissions (class_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (p_class_id, clean, name_key(clean), p_dob, coalesce(allowed_busy, '{}'), p_status, now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_name = excluded.student_name, busy_slots = excluded.busy_slots, status = excluded.status, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_teacher_accounts(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'name', a.display_name,
      'username', a.username,
      'classIds', coalesce((select jsonb_agg(x.class_id order by x.class_id) from teacher_class_assignments x where x.teacher_id = a.id), '[]'::jsonb)
    ) order by lower(a.display_name), a.display_name, lower(a.username))
    from teacher_accounts a where a.active
  ), '[]'::jsonb);
end;
$$;

create or replace function api_add_teacher_account(teacher_key text, display_name text, username text, password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  perform require_owner(teacher_key);
  if clean_name(api_add_teacher_account.display_name) = '' or clean_name(api_add_teacher_account.username) = '' or length(api_add_teacher_account.password) < 6 then
    raise exception 'Nhập đủ tên, tài khoản và mật khẩu từ 6 ký tự';
  end if;
  insert into teacher_accounts (display_name, username, password_hash)
  values (clean_name(api_add_teacher_account.display_name), clean_name(api_add_teacher_account.username), extensions.crypt(api_add_teacher_account.password, extensions.gen_salt('bf')))
  returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
exception when unique_violation then
  raise exception 'Tài khoản này đã tồn tại';
end;
$$;

create or replace function api_set_teacher_classes(teacher_key text, teacher_id uuid, class_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  if not exists (select 1 from teacher_accounts a where a.id = api_set_teacher_classes.teacher_id and a.active) then
    raise exception 'Không tìm thấy giáo viên';
  end if;
  delete from teacher_class_assignments a where a.teacher_id = api_set_teacher_classes.teacher_id;
  insert into teacher_class_assignments (teacher_id, class_id)
  select api_set_teacher_classes.teacher_id, c.id
  from classes c
  where c.id = any(coalesce(api_set_teacher_classes.class_ids, '{}')) and not c.archived;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_delete_teacher_account(teacher_key text, teacher_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  delete from teacher_accounts a where a.id = api_delete_teacher_account.teacher_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Every existing write RPC is owner-only from this point onward.
create or replace function api_set_archived(teacher_key text, class_id text, archived boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_owner(teacher_key);
  update classes set archived = api_set_archived.archived where id = api_set_archived.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_delete_class(teacher_key text, class_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin perform require_owner(teacher_key); delete from classes where id = api_delete_class.class_id; return jsonb_build_object('ok', true); end; $$;

create or replace function api_clear_archived(teacher_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin perform require_owner(teacher_key); delete from classes where archived; return jsonb_build_object('ok', true); end; $$;

create or replace function api_archived_classes(teacher_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin perform require_owner(teacher_key); return coalesce((select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id) from classes c where c.archived), '[]'::jsonb); end; $$;

create or replace function api_add_student(teacher_key text, class_id text, student_name text, dob date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare clean text := clean_name(api_add_student.student_name);
begin
  perform require_owner(teacher_key);
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if api_add_student.dob is null then raise exception 'Thiếu ngày sinh'; end if;
  insert into submissions (class_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (api_add_student.class_id, clean, name_key(clean), api_add_student.dob, '{}', 'approved', now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_name = excluded.student_name, status = 'approved', updated_at = now();
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_set_submission_status(teacher_key text, class_id text, student_name text, dob date, status text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_owner(teacher_key);
  update submissions set student_name = clean_name(api_set_submission_status.student_name), name_key = name_key(api_set_submission_status.student_name), status = api_set_submission_status.status, updated_at = now()
  where submissions.class_id = api_set_submission_status.class_id and submissions.name_key = name_key(api_set_submission_status.student_name) and submissions.dob = api_set_submission_status.dob;
  if not found then raise exception 'Không tìm thấy đăng ký'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_delete_submission(teacher_key text, class_id text, student_name text, dob date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin perform require_owner(teacher_key); delete from submissions where submissions.class_id = api_delete_submission.class_id and submissions.name_key = name_key(api_delete_submission.student_name) and submissions.dob = api_delete_submission.dob; return jsonb_build_object('ok', true); end; $$;

create or replace function api_update_busy(teacher_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_owner(teacher_key);
  update submissions set busy_slots = coalesce(api_update_busy.busy_slots, '{}'), updated_at = now()
  where submissions.class_id = api_update_busy.class_id and submissions.name_key = name_key(api_update_busy.student_name) and submissions.dob = api_update_busy.dob;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_bulk_update_busy(teacher_key text, class_id text, updates jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item jsonb; count_updated int := 0;
begin
  perform require_owner(teacher_key);
  for item in select * from jsonb_array_elements(coalesce(updates, '[]'::jsonb)) loop
    update submissions set busy_slots = coalesce(array(select jsonb_array_elements_text(item->'busySlots')), '{}'), updated_at = now()
    where submissions.class_id = api_bulk_update_busy.class_id and submissions.name_key = name_key(item->>'studentName') and submissions.dob = (item->>'dob')::date;
    if found then count_updated := count_updated + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'count', count_updated);
end; $$;

grant execute on all functions in schema public to anon;
