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

-- Student lookup privacy: return only the matching student row and reveal the
-- class final schedule only when full name + date of birth match.
create or replace function api_student_class(
  student_key text,
  class_id text,
  student_name text,
  dob date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
  target_key text := name_key(api_student_class.student_name);
  matched boolean;
begin
  perform require_student(student_key);
  if target_key = '' or api_student_class.dob is null then
    raise exception 'Nhập họ tên và ngày sinh để tra cứu';
  end if;

  select * into c
  from classes
  where classes.id = api_student_class.class_id and not classes.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select exists (
    select 1
    from submissions s
    left join students st on st.id = s.student_id
    where s.class_id = c.id
      and s.status = 'approved'
      and coalesce(st.name_key, s.name_key) = target_key
      and coalesce(st.dob, s.dob) = api_student_class.dob
  ) into matched;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', case when matched then to_jsonb(c.current_slots) else '[]'::jsonb end,
    'finalSubjects', case when matched then c.final_subjects else '{}'::jsonb end,
    'canRequestChange', matched,
    'submissions', case when matched then coalesce((
      select jsonb_agg(jsonb_build_object(
        'studentName', coalesce(st.student_name, s.student_name),
        'displayName', coalesce(st.student_name, s.student_name),
        'dob', coalesce(st.dob, s.dob)::text,
        'busySlots', s.busy_slots,
        'status', s.status,
        'canEdit', true
      ))
      from submissions s
      left join students st on st.id = s.student_id
      where s.class_id = c.id
        and s.status = 'approved'
        and coalesce(st.name_key, s.name_key) = target_key
        and coalesce(st.dob, s.dob) = api_student_class.dob
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

grant execute on all functions in schema public to anon;

-- Keep these weekly-planner overrides last because earlier migration blocks also
-- define the legacy current-schedule RPCs.
create or replace function api_set_current_slots(
  teacher_key text,
  class_id text,
  current_slots text[],
  final_subjects jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes;
  cleaned text[];
  preserved_subjects jsonb;
begin
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid;

  select coalesce(jsonb_object_agg(slot, subject), '{}'::jsonb)
  into preserved_subjects
  from (
    select slot, coalesce(
      nullif(clean_name(api_set_current_slots.final_subjects->>slot), ''),
      nullif(clean_name(c.final_subjects->>slot), '')
    ) subject
    from unnest(cleaned) slot
  ) x
  where subject is not null;

  update classes
  set current_slots = cleaned, final_subjects = preserved_subjects
  where id = c.id;

  return jsonb_build_object('ok', true, 'currentSlots', cleaned, 'finalSubjects', preserved_subjects);
end;
$$;

create or replace function api_final_schedule(teacher_key text)
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
    where not c.archived and can_access_class(teacher_key, c.id)
  ), '[]'::jsonb);
end;
$$;

grant execute on all functions in schema public to anon;

-- Final weekly-planner overrides (must remain at the end of this migration file).
create or replace function api_set_current_slots(
  teacher_key text,
  class_id text,
  current_slots text[],
  final_subjects jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c classes; cleaned text[]; preserved_subjects jsonb;
begin
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid;
  select coalesce(jsonb_object_agg(slot, subject), '{}'::jsonb) into preserved_subjects
  from (
    select slot, coalesce(
      nullif(clean_name(api_set_current_slots.final_subjects->>slot), ''),
      nullif(clean_name(c.final_subjects->>slot), '')
    ) subject
    from unnest(cleaned) slot
  ) x where subject is not null;
  update classes set current_slots = cleaned, final_subjects = preserved_subjects where id = c.id;
  return jsonb_build_object('ok', true, 'currentSlots', cleaned, 'finalSubjects', preserved_subjects);
end;
$$;

create or replace function api_final_schedule(teacher_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_teacher(teacher_key);
  return coalesce((
    select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id)
    from classes c
    where not c.archived and can_access_class(teacher_key, c.id)
  ), '[]'::jsonb);
end;
$$;

grant execute on all functions in schema public to anon;

-- 2026-07-09: weekly class planner. One compact JSON object is stored per class/week.
alter table classes
  add column if not exists lesson_starts jsonb not null
  default '{"S":1,"W":1,"LR":1}'::jsonb;

create table if not exists class_schedule_weeks (
  id uuid primary key default gen_random_uuid(),
  class_id text not null references classes(id) on delete cascade,
  week_start date not null,
  title text not null,
  slots jsonb not null default '{}'::jsonb,
  active_slots text[] not null default '{}',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, week_start)
);

alter table class_schedule_weeks
  add column if not exists active_slots text[] not null default '{}';
alter table class_schedule_weeks
  add column if not exists details jsonb not null default '{}'::jsonb;

create index if not exists class_schedule_weeks_class_date_idx
  on class_schedule_weeks (class_id, week_start desc);

alter table class_schedule_weeks enable row level security;
drop policy if exists "deny direct class schedule weeks" on class_schedule_weeks;
create policy "deny direct class schedule weeks"
  on class_schedule_weeks for all using (false) with check (false);

create or replace function api_schedule_class(
  teacher_key text,
  class_id text,
  selected_week_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
  monday date := current_date - (extract(isodow from current_date)::int - 1);
  requested date := coalesce(api_schedule_class.selected_week_start, monday);
  selected_week jsonb;
begin
  perform require_class_manager(teacher_key, api_schedule_class.class_id);
  select * into c from classes where id = api_schedule_class.class_id and not archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select jsonb_build_object(
    'weekStart', w.week_start::text,
    'title', w.title,
    'slots', w.slots,
    'activeSlots', w.active_slots,
    'details', w.details
  ) into selected_week
  from class_schedule_weeks w
  where w.class_id = c.id and w.week_start = requested;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', c.current_slots,
    'finalSubjects', c.final_subjects,
    'lessonStarts', c.lesson_starts,
    'sectorId', c.sector_id,
    'sectorName', (select s.name from class_sectors s where s.id = c.sector_id),
    'currentWeekStart', monday::text,
    'selectedWeekStart', requested::text,
    'selectedWeek', selected_week,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start::text,
        'title', w.title
      ) order by w.week_start desc)
      from class_schedule_weeks w
      where w.class_id = c.id
    ), '[]'::jsonb),
    'lessonMaximums', jsonb_build_object(
      'S', coalesce((select max((regexp_match(value, '^S([0-9]+)$'))[1]::int)
                     from class_schedule_weeks w, jsonb_each_text(w.slots)
                     where w.class_id = c.id and value ~ '^S[0-9]+$'), 0),
      'W', coalesce((select max((regexp_match(value, '^W([0-9]+)$'))[1]::int)
                     from class_schedule_weeks w, jsonb_each_text(w.slots)
                     where w.class_id = c.id and value ~ '^W[0-9]+$'), 0),
      'LR', coalesce((select max((regexp_match(value, '^LR([0-9]+)$'))[1]::int)
                      from class_schedule_weeks w, jsonb_each_text(w.slots)
                      where w.class_id = c.id and value ~ '^LR[0-9]+$'), 0)
    )
  );
end;
$$;

create or replace function api_save_schedule_week(
  teacher_key text,
  class_id text,
  week_start date,
  title text,
  week_slots jsonb,
  week_details jsonb,
  current_slots text[],
  sessions text[],
  lesson_starts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes;
  clean_sessions text[];
  clean_current text[];
  clean_slots jsonb;
  clean_details jsonb;
  clean_starts jsonb;
begin
  perform require_class_manager(teacher_key, api_save_schedule_week.class_id);
  select * into c from classes where id = api_save_schedule_week.class_id and not archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  if api_save_schedule_week.week_start is null then raise exception 'Thiếu ngày bắt đầu tuần'; end if;

  select coalesce(array_agg(value order by ord), '{}') into clean_sessions
  from (
    select min(ord) ord, clean_name(value) value
    from unnest(coalesce(api_save_schedule_week.sessions, '{}')) with ordinality t(value, ord)
    where clean_name(value) <> ''
    group by lower(clean_name(value)), clean_name(value)
    order by min(ord)
    limit 12
  ) x;
  if coalesce(array_length(clean_sessions, 1), 0) = 0 then
    raise exception 'Cần ít nhất một ca';
  end if;

  select coalesce(array_agg(slot order by slot), '{}') into clean_current
  from (
    select distinct clean_name(value) slot
    from unnest(coalesce(api_save_schedule_week.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(clean_sessions, 1)
  ) valid;

  select coalesce(jsonb_object_agg(key, upper(clean_name(value))), '{}'::jsonb)
  into clean_slots
  from jsonb_each_text(coalesce(api_save_schedule_week.week_slots, '{}'::jsonb))
  where key = any(clean_current)
    and upper(clean_name(value)) ~ '^(S[0-9]+|W[0-9]+|LR[0-9]+|MT|FT|REVIEW)$';

  select coalesce(jsonb_object_agg(key, jsonb_build_object(
    'location', left(clean_name(value->>'location'), 80),
    'note', left(clean_name(value->>'note'), 300)
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_week.week_details, '{}'::jsonb))
  where key = any(clean_current)
    and (clean_name(value->>'location') <> '' or clean_name(value->>'note') <> '');

  clean_starts := jsonb_build_object(
    'S', greatest(coalesce((api_save_schedule_week.lesson_starts->>'S')::int, 1), 1),
    'W', greatest(coalesce((api_save_schedule_week.lesson_starts->>'W')::int, 1), 1),
    'LR', greatest(coalesce((api_save_schedule_week.lesson_starts->>'LR')::int, 1), 1)
  );

  update classes
  set sessions = clean_sessions,
      current_slots = clean_current,
      final_subjects = clean_slots,
      lesson_starts = clean_starts
  where id = c.id;

  insert into class_schedule_weeks (class_id, week_start, title, slots, active_slots, details, updated_at)
  values (
    c.id,
    api_save_schedule_week.week_start,
    coalesce(nullif(clean_name(api_save_schedule_week.title), ''), 'Tuần'),
    clean_slots,
    clean_current,
    clean_details,
    now()
  )
  on conflict on constraint class_schedule_weeks_class_id_week_start_key do update
  set title = excluded.title,
      slots = excluded.slots,
      active_slots = excluded.active_slots,
      details = excluded.details,
      updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- The class tab controls yellow cells only. Lesson labels are edited in the Lịch tab.
create or replace function api_set_current_slots(
  teacher_key text,
  class_id text,
  current_slots text[],
  final_subjects jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes;
  cleaned text[];
  preserved_subjects jsonb;
begin
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid;

  select coalesce(jsonb_object_agg(slot, subject), '{}'::jsonb)
  into preserved_subjects
  from (
    select slot, coalesce(
      nullif(clean_name(api_set_current_slots.final_subjects->>slot), ''),
      nullif(clean_name(c.final_subjects->>slot), '')
    ) subject
    from unnest(cleaned) slot
  ) x
  where subject is not null;

  update classes
  set current_slots = cleaned,
      final_subjects = preserved_subjects
  where id = c.id;

  return jsonb_build_object(
    'ok', true,
    'currentSlots', cleaned,
    'finalSubjects', preserved_subjects
  );
end;
$$;

create or replace function api_final_schedule(teacher_key text)
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
    where not c.archived and can_access_class(teacher_key, c.id)
  ), '[]'::jsonb);
end;
$$;

grant execute on all functions in schema public to anon;

-- Teacher accounts, class assignments and current class schedule.
-- This section is also safe to run as a migration on an existing database.
alter table classes add column if not exists current_slots text[] not null default '{}';

create table if not exists class_sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table classes add column if not exists sector_id uuid references class_sectors(id) on delete set null;
create index if not exists classes_sector_id_idx on classes(sector_id);

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
alter table class_sectors enable row level security;

drop policy if exists "deny direct teacher_accounts" on teacher_accounts;
drop policy if exists "deny direct teacher_class_assignments" on teacher_class_assignments;
drop policy if exists "deny direct teacher_sessions" on teacher_sessions;
drop policy if exists "deny direct class_sectors" on class_sectors;
create policy "deny direct teacher_accounts" on teacher_accounts for all using (false) with check (false);
create policy "deny direct teacher_class_assignments" on teacher_class_assignments for all using (false) with check (false);
create policy "deny direct teacher_sessions" on teacher_sessions for all using (false) with check (false);
create policy "deny direct class_sectors" on class_sectors for all using (false) with check (false);

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

create or replace function require_class_manager(teacher_key text, target_class_id text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  if not can_access_class(teacher_key, target_class_id) then
    raise exception 'Khong co quyen quan ly lop nay';
  end if;
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
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
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
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
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
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
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

create or replace function api_rename_class(teacher_key text, class_id text, name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare cleaned text := clean_name(name);
begin
  perform require_owner(teacher_key);
  if cleaned = '' then raise exception 'Thiếu tên lớp'; end if;
  update classes
  set name = cleaned
  where id = api_rename_class.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true, 'id', api_rename_class.class_id, 'name', cleaned);
end;
$$;

create or replace function api_class_sectors(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'classIds', coalesce((select jsonb_agg(c.id order by lower(c.name), c.name, c.id) from classes c where c.sector_id = s.id and not c.archived), '[]'::jsonb)
      )
      order by lower(s.name), s.name, s.id
    )
    from class_sectors s
  ), '[]'::jsonb);
end;
$$;

create or replace function api_add_class_sector(teacher_key text, name text, class_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text := clean_name(name);
  new_id uuid;
begin
  perform require_owner(teacher_key);
  if cleaned = '' then raise exception 'Thiếu tên sector'; end if;
  insert into class_sectors (name) values (cleaned) returning id into new_id;
  update classes c
  set sector_id = new_id
  where not c.archived
    and c.sector_id is null
    and c.id = any(coalesce(api_add_class_sector.class_ids, '{}'));
  return jsonb_build_object('ok', true, 'id', new_id, 'name', cleaned);
end;
$$;

create or replace function api_update_class_sector(teacher_key text, sector_id uuid, name text, class_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text := clean_name(name);
  wanted text[] := coalesce(api_update_class_sector.class_ids, '{}');
begin
  perform require_owner(teacher_key);
  if cleaned = '' then raise exception 'Thiếu tên sector'; end if;
  update class_sectors s set name = cleaned where s.id = api_update_class_sector.sector_id;
  if not found then raise exception 'Không tìm thấy sector'; end if;

  update classes c
  set sector_id = null
  where c.sector_id = api_update_class_sector.sector_id
    and not (c.id = any(wanted));

  update classes c
  set sector_id = api_update_class_sector.sector_id
  where not c.archived
    and (c.sector_id is null or c.sector_id = api_update_class_sector.sector_id)
    and c.id = any(wanted);

  return jsonb_build_object('ok', true, 'id', api_update_class_sector.sector_id, 'name', cleaned);
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
  perform require_class_manager(teacher_key, api_set_class_sessions.class_id);
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

-- Global administration stays owner-only; assigned teachers can manage their own classes.
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
  perform require_class_manager(teacher_key, api_add_student.class_id);
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
  perform require_class_manager(teacher_key, api_set_submission_status.class_id);
  update submissions set student_name = clean_name(api_set_submission_status.student_name), name_key = name_key(api_set_submission_status.student_name), status = api_set_submission_status.status, updated_at = now()
  where submissions.class_id = api_set_submission_status.class_id and submissions.name_key = name_key(api_set_submission_status.student_name) and submissions.dob = api_set_submission_status.dob;
  if not found then raise exception 'Không tìm thấy đăng ký'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_delete_submission(teacher_key text, class_id text, student_name text, dob date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin perform require_class_manager(teacher_key, api_delete_submission.class_id); delete from submissions where submissions.class_id = api_delete_submission.class_id and submissions.name_key = name_key(api_delete_submission.student_name) and submissions.dob = api_delete_submission.dob; return jsonb_build_object('ok', true); end; $$;

create or replace function api_update_busy(teacher_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_class_manager(teacher_key, api_update_busy.class_id);
  update submissions set busy_slots = coalesce(api_update_busy.busy_slots, '{}'), updated_at = now()
  where submissions.class_id = api_update_busy.class_id and submissions.name_key = name_key(api_update_busy.student_name) and submissions.dob = api_update_busy.dob;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_bulk_update_busy(teacher_key text, class_id text, updates jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item jsonb; count_updated int := 0;
begin
  perform require_class_manager(teacher_key, api_bulk_update_busy.class_id);
  for item in select * from jsonb_array_elements(coalesce(updates, '[]'::jsonb)) loop
    update submissions set busy_slots = coalesce(array(select jsonb_array_elements_text(item->'busySlots')), '{}'), updated_at = now()
    where submissions.class_id = api_bulk_update_busy.class_id and submissions.name_key = name_key(item->>'studentName') and submissions.dob = (item->>'dob')::date;
    if found then count_updated := count_updated + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'count', count_updated);
end; $$;

grant execute on all functions in schema public to anon;

-- 2026-07-09: global students, transfer/manage tools, and final schedule subjects.
create or replace function title_name(value text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(initcap(lower(clean_name(value))), '\s+', ' ', 'g'));
$$;

alter table classes add column if not exists final_subjects jsonb not null default '{}'::jsonb;

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  student_name text not null,
  name_key text not null,
  dob date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name_key, dob)
);

alter table students enable row level security;
drop policy if exists "deny direct students" on students;
create policy "deny direct students" on students for all using (false) with check (false);

alter table submissions add column if not exists student_id uuid references students(id) on delete cascade;

insert into students (student_name, name_key, dob)
select distinct title_name(s.student_name), name_key(title_name(s.student_name)), s.dob
from submissions s
where s.dob is not null
on conflict on constraint students_name_key_dob_key do update
set student_name = excluded.student_name,
    updated_at = now();

update submissions s
set student_id = st.id,
    student_name = st.student_name,
    name_key = st.name_key
from students st
where st.name_key = name_key(title_name(s.student_name))
  and st.dob = s.dob;

create or replace function ensure_student(student_name text, dob date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := title_name(student_name);
  result_id uuid;
begin
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if dob is null then raise exception 'Thiếu ngày sinh'; end if;

  insert into students (student_name, name_key, dob, updated_at)
  values (clean, name_key(clean), dob, now())
  on conflict on constraint students_name_key_dob_key do update
  set student_name = excluded.student_name,
      updated_at = now()
  returning id into result_id;

  return result_id;
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
    'finalSubjects', c.final_subjects,
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
    'approvedCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'approved'),
    'pendingCount', (select count(*) from submissions s where s.class_id = c.id and s.status = 'pending')
  );
$$;

create or replace function teacher_submission_json(s submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'studentName', coalesce(st.student_name, s.student_name),
    'dob', coalesce(st.dob, s.dob)::text,
    'busySlots', s.busy_slots,
    'status', s.status,
    'studentId', coalesce(s.student_id, st.id),
    'classIds', coalesce((
      select jsonb_agg(x.class_id order by lower(c.name), c.name, x.class_id)
      from submissions x
      join classes c on c.id = x.class_id and not c.archived
      where (x.student_id is not null and x.student_id = coalesce(s.student_id, st.id))
         or (x.student_id is null and x.name_key = coalesce(st.name_key, s.name_key) and x.dob = coalesce(st.dob, s.dob))
    ), '[]'::jsonb)
  )
  from students st
  where st.id = s.student_id
  union all
  select jsonb_build_object(
    'studentName', s.student_name,
    'dob', s.dob::text,
    'busySlots', s.busy_slots,
    'status', s.status,
    'studentId', s.student_id,
    'classIds', coalesce((select jsonb_agg(x.class_id order by x.class_id) from submissions x where x.name_key = s.name_key and x.dob = s.dob), '[]'::jsonb)
  )
  where s.student_id is null
  limit 1;
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
    'finalSubjects', c.final_subjects,
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
    'submissions', coalesce((select jsonb_agg(teacher_submission_json(s) order by lower(coalesce(st.student_name, s.student_name)), coalesce(st.student_name, s.student_name), coalesce(st.dob, s.dob)) from submissions s left join students st on st.id = s.student_id where s.class_id = c.id), '[]'::jsonb)
  );
end;
$$;

create or replace function api_final_schedule(teacher_key text)
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
    where not c.archived
      and coalesce(array_length(c.current_slots, 1), 0) > 0
      and can_access_class(teacher_key, c.id)
  ), '[]'::jsonb);
end;
$$;

drop function if exists api_set_current_slots(text, text, text[]);
create or replace function api_set_current_slots(teacher_key text, class_id text, current_slots text[], final_subjects jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c classes;
  cleaned text[];
  cleaned_subjects jsonb;
begin
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) as slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid_slots;

  select coalesce(jsonb_object_agg(slot, coalesce(nullif(clean_name(final_subjects->>slot), ''), 'speaking')), '{}'::jsonb)
  into cleaned_subjects
  from unnest(cleaned) slot;

  update classes set current_slots = cleaned, final_subjects = cleaned_subjects where id = c.id;
  return jsonb_build_object('ok', true, 'currentSlots', cleaned, 'finalSubjects', cleaned_subjects);
end;
$$;

create or replace function upsert_submission(p_class_id text, p_student_name text, p_dob date, p_busy_slots text[], p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := title_name(p_student_name);
  allowed_busy text[];
  sid uuid;
begin
  sid := ensure_student(clean, p_dob);
  select array(select unnest(coalesce(p_busy_slots, '{}')) except select unnest(c.current_slots))
    into allowed_busy from classes c where c.id = p_class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (p_class_id, sid, clean, name_key(clean), p_dob, coalesce(allowed_busy, '{}'), p_status, now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_id = excluded.student_id, student_name = excluded.student_name, name_key = excluded.name_key, busy_slots = excluded.busy_slots, status = excluded.status, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_add_student(teacher_key text, class_id text, student_name text, dob date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare clean text := title_name(api_add_student.student_name); sid uuid;
begin
  perform require_class_manager(teacher_key, api_add_student.class_id);
  sid := ensure_student(clean, api_add_student.dob);
  insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (api_add_student.class_id, sid, clean, name_key(clean), api_add_student.dob, '{}', 'approved', now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_id = excluded.student_id, student_name = excluded.student_name, name_key = excluded.name_key, status = 'approved', updated_at = now();
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_set_submission_status(teacher_key text, class_id text, student_name text, dob date, status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare clean text := title_name(api_set_submission_status.student_name); sid uuid;
begin
  perform require_class_manager(teacher_key, api_set_submission_status.class_id);
  sid := ensure_student(clean, api_set_submission_status.dob);
  update submissions set student_id = sid, student_name = clean, name_key = name_key(clean), dob = api_set_submission_status.dob, status = api_set_submission_status.status, updated_at = now()
  where submissions.class_id = api_set_submission_status.class_id and submissions.name_key = name_key(clean) and submissions.dob = api_set_submission_status.dob;
  if not found then raise exception 'Không tìm thấy đăng ký'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_update_busy(teacher_key text, class_id text, student_name text, dob date, busy_slots text[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_class_manager(teacher_key, api_update_busy.class_id);
  update submissions set busy_slots = coalesce(api_update_busy.busy_slots, '{}'), updated_at = now()
  where submissions.class_id = api_update_busy.class_id and submissions.name_key = name_key(api_update_busy.student_name) and submissions.dob = api_update_busy.dob;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_transfer_submission(teacher_key text, class_id text, student_name text, dob date, target_class_ids text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  source submissions;
  target_id text;
  clean text;
  sid uuid;
  allowed_busy text[];
begin
  perform require_class_manager(teacher_key, api_transfer_submission.class_id);
  select * into source from submissions s
  where s.class_id = api_transfer_submission.class_id
    and s.name_key = name_key(api_transfer_submission.student_name)
    and s.dob = api_transfer_submission.dob;
  if not found then raise exception 'Không tìm thấy phiếu cần chuyển'; end if;

  clean := title_name(source.student_name);
  sid := coalesce(source.student_id, ensure_student(clean, source.dob));

  if coalesce(array_length(api_transfer_submission.target_class_ids, 1), 0) = 0 then
    raise exception 'Chọn ít nhất 1 lớp để chuyển';
  end if;

  foreach target_id in array api_transfer_submission.target_class_ids loop
    perform require_class_manager(teacher_key, target_id);
    select array(select unnest(source.busy_slots) except select unnest(c.current_slots)) into allowed_busy from classes c where c.id = target_id and not c.archived;
    insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
    values (target_id, sid, clean, name_key(clean), source.dob, coalesce(allowed_busy, '{}'), source.status, now())
    on conflict on constraint submissions_class_id_name_key_dob_key
    do update set student_id = excluded.student_id, student_name = excluded.student_name, busy_slots = excluded.busy_slots, status = excluded.status, updated_at = now();
  end loop;

  if not (api_transfer_submission.class_id = any(api_transfer_submission.target_class_ids)) then
    delete from submissions s where s.id = source.id;
  end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function api_update_student_profile_classes(teacher_key text, class_id text, old_student_name text, old_dob date, new_student_name text, new_dob date, class_ids text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  source submissions;
  source_student_id uuid;
  target_student_id uuid;
  clean text := title_name(api_update_student_profile_classes.new_student_name);
  target_id text;
  source_busy text[] := '{}';
begin
  perform require_class_manager(teacher_key, api_update_student_profile_classes.class_id);
  if clean = '' or api_update_student_profile_classes.new_dob is null then raise exception 'Nhập họ tên và ngày sinh'; end if;
  if coalesce(array_length(api_update_student_profile_classes.class_ids, 1), 0) = 0 then raise exception 'Chọn ít nhất 1 lớp'; end if;

  select * into source from submissions s
  where s.class_id = api_update_student_profile_classes.class_id
    and s.name_key = name_key(api_update_student_profile_classes.old_student_name)
    and s.dob = api_update_student_profile_classes.old_dob;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;

  source_student_id := coalesce(source.student_id, ensure_student(source.student_name, source.dob));
  target_student_id := ensure_student(clean, api_update_student_profile_classes.new_dob);
  source_busy := source.busy_slots;

  delete from submissions s
  using submissions t
  where s.id <> t.id
    and s.class_id = t.class_id
    and (s.student_id = source_student_id or (s.student_id is null and s.name_key = name_key(api_update_student_profile_classes.old_student_name) and s.dob = api_update_student_profile_classes.old_dob))
    and (t.student_id = target_student_id or (t.name_key = name_key(clean) and t.dob = api_update_student_profile_classes.new_dob));

  update submissions s
  set student_id = target_student_id,
      student_name = clean,
      name_key = name_key(clean),
      dob = api_update_student_profile_classes.new_dob,
      updated_at = now()
  where s.student_id = source_student_id
     or (s.student_id is null and s.name_key = name_key(api_update_student_profile_classes.old_student_name) and s.dob = api_update_student_profile_classes.old_dob);

  foreach target_id in array api_update_student_profile_classes.class_ids loop
    perform require_class_manager(teacher_key, target_id);
    insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
    values (target_id, target_student_id, clean, name_key(clean), api_update_student_profile_classes.new_dob, source_busy, 'approved', now())
    on conflict on constraint submissions_class_id_name_key_dob_key
    do update set student_id = excluded.student_id, student_name = excluded.student_name, name_key = excluded.name_key, dob = excluded.dob, status = 'approved', updated_at = now();
  end loop;

  delete from submissions s
  where s.student_id = target_student_id
    and can_access_class(teacher_key, s.class_id)
    and not (s.class_id = any(api_update_student_profile_classes.class_ids));

  return jsonb_build_object('ok', true);
end; $$;

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
    'finalSubjects', c.final_subjects,
    'canRequestChange', exists (
      select 1 from submissions s left join students st on st.id = s.student_id
      where s.class_id = c.id and s.status = 'approved' and coalesce(st.name_key, s.name_key) = target_key and coalesce(st.dob, s.dob) = api_student_class.dob
    ),
    'submissions', coalesce((
      with approved as (
        select s.*, coalesce(st.student_name, s.student_name) as display_student_name,
               coalesce(st.name_key, s.name_key) as display_name_key,
               coalesce(st.dob, s.dob) as display_dob,
               count(*) over (partition by coalesce(st.name_key, s.name_key)) as same_name_count
        from submissions s
        left join students st on st.id = s.student_id
        where s.class_id = c.id and s.status = 'approved'
      )
      select jsonb_agg(jsonb_build_object(
        'studentName', a.display_student_name,
        'displayName', case when a.same_name_count >= 2 then a.display_student_name || ' (' || dob_note(a.display_dob) || ')' else a.display_student_name end,
        'busySlots', a.busy_slots,
        'status', a.status,
        'canEdit', a.display_name_key = target_key and a.display_dob = api_student_class.dob
      ) order by lower(a.display_student_name), a.display_student_name, a.display_dob)
      from approved a
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on all functions in schema public to anon;

-- Effective weekly-planner overrides. Keep this block at EOF.
create or replace function api_set_current_slots(
  teacher_key text,
  class_id text,
  current_slots text[],
  final_subjects jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c classes; cleaned text[]; preserved_subjects jsonb;
begin
  perform require_class_manager(teacher_key, api_set_current_slots.class_id);
  select * into c from classes where id = api_set_current_slots.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  select coalesce(array_agg(slot order by slot), '{}') into cleaned
  from (
    select distinct clean_name(value) slot
    from unnest(coalesce(api_set_current_slots.current_slots, '{}')) value
    where clean_name(value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(value), '-', 2)::int < array_length(c.sessions, 1)
  ) valid;
  select coalesce(jsonb_object_agg(slot, subject), '{}'::jsonb) into preserved_subjects
  from (
    select slot, coalesce(
      nullif(clean_name(api_set_current_slots.final_subjects->>slot), ''),
      nullif(clean_name(c.final_subjects->>slot), '')
    ) subject
    from unnest(cleaned) slot
  ) x where subject is not null;
  update classes set current_slots = cleaned, final_subjects = preserved_subjects where id = c.id;
  return jsonb_build_object('ok', true, 'currentSlots', cleaned, 'finalSubjects', preserved_subjects);
end;
$$;

create or replace function api_final_schedule(teacher_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_teacher(teacher_key);
  return coalesce((
    select jsonb_agg(class_summary(c) order by lower(c.name), c.name, c.id)
    from classes c
    where not c.archived and can_access_class(teacher_key, c.id)
  ), '[]'::jsonb);
end;
$$;

grant execute on all functions in schema public to anon;

-- One-time reset requested on 2026-07-09: keep yellow slots, clear their old labels.
do $reset_old_schedule_labels$
begin
  if not exists (
    select 1 from app_settings
    where key = 'MIGRATION_EMPTY_SCHEDULE_LABELS_20260709'
  ) then
    update classes set final_subjects = '{}'::jsonb;
    update class_schedule_weeks set slots = '{}'::jsonb, updated_at = now();
    insert into app_settings (key, value)
    values ('MIGRATION_EMPTY_SCHEDULE_LABELS_20260709', 'done')
    on conflict (key) do nothing;
  end if;
end;
$reset_old_schedule_labels$;

-- Remove the previous weekly-save overload after adding per-slot details.
drop function if exists api_save_schedule_week(text, text, date, text, jsonb, text[], text[], jsonb);

create or replace function api_public_schedule(student_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c classes;
  monday date := current_date - (extract(isodow from current_date)::int - 1);
  w class_schedule_weeks;
begin
  perform require_student(student_key);
  select * into c from classes where id = api_public_schedule.class_id and not archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select * into w
  from class_schedule_weeks
  where class_schedule_weeks.class_id = c.id and week_start = monday;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'weekStart', monday::text,
    'title', coalesce(w.title, 'Tuần hiện tại'),
    'activeSlots', coalesce(w.active_slots, c.current_slots),
    'slots', coalesce(w.slots, c.final_subjects, '{}'::jsonb),
    'details', coalesce(w.details, '{}'::jsonb)
  );
end;
$$;

grant execute on all functions in schema public to anon;

-- Effective private lookup override. Keep after all legacy api_student_class definitions.
create or replace function api_student_class(
  student_key text,
  class_id text,
  student_name text,
  dob date
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c classes;
  target_key text := name_key(api_student_class.student_name);
  matched boolean;
begin
  perform require_student(student_key);
  if target_key = '' or api_student_class.dob is null then
    raise exception 'Nhập họ tên và ngày sinh để tra cứu';
  end if;
  select * into c from classes
  where classes.id = api_student_class.class_id and not classes.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select exists (
    select 1 from submissions s
    left join students st on st.id = s.student_id
    where s.class_id = c.id and s.status = 'approved'
      and coalesce(st.name_key, s.name_key) = target_key
      and coalesce(st.dob, s.dob) = api_student_class.dob
  ) into matched;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', case when matched then to_jsonb(c.current_slots) else '[]'::jsonb end,
    'finalSubjects', case when matched then c.final_subjects else '{}'::jsonb end,
    'canRequestChange', matched,
    'submissions', case when matched then coalesce((
      select jsonb_agg(jsonb_build_object(
        'studentName', coalesce(st.student_name, s.student_name),
        'displayName', coalesce(st.student_name, s.student_name),
        'dob', coalesce(st.dob, s.dob)::text,
        'busySlots', s.busy_slots,
        'status', s.status,
        'canEdit', true
      ))
      from submissions s
      left join students st on st.id = s.student_id
      where s.class_id = c.id and s.status = 'approved'
        and coalesce(st.name_key, s.name_key) = target_key
        and coalesce(st.dob, s.dob) = api_student_class.dob
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

grant execute on all functions in schema public to anon;


-- Cross-class conflicts for students enrolled in 2+ classes.
-- Orange cells on the frontend use this map: slot id -> other class name(s).
create or replace function submission_other_class_slots(source_submission submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with src as (
    select
      coalesce(st.name_key, source_submission.name_key) as src_key,
      coalesce(st.dob, source_submission.dob) as src_dob
    from (select 1) one
    left join students st on st.id = source_submission.student_id
  ), slot_classes as (
    select distinct slot_value as slot, oc.name as class_name
    from submissions x
    join classes oc on oc.id = x.class_id and not oc.archived
    left join students xst on xst.id = x.student_id
    cross join unnest(coalesce(oc.current_slots, '{}')) as slots(slot_value)
    cross join src
    where x.status = 'approved'
      and x.class_id <> source_submission.class_id
      and coalesce(xst.name_key, x.name_key) = src.src_key
      and coalesce(xst.dob, x.dob) = src.src_dob
  ), grouped as (
    select slot, string_agg(class_name, '/' order by lower(class_name), class_name) as label
    from slot_classes
    group by slot
  )
  select coalesce(jsonb_object_agg(slot, label), '{}'::jsonb)
  from grouped;
$$;

create or replace function teacher_submission_json(s submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'studentName', coalesce(st.student_name, s.student_name),
    'dob', coalesce(st.dob, s.dob)::text,
    'busySlots', s.busy_slots,
    'otherClassSlots', submission_other_class_slots(s),
    'status', s.status,
    'updatedAt', s.updated_at,
    'studentId', s.student_id,
    'classIds', coalesce((
      select jsonb_agg(x.class_id order by lower(c.name), c.name, x.class_id)
      from submissions x
      join classes c on c.id = x.class_id and not c.archived
      left join students xst on xst.id = x.student_id
      where coalesce(xst.name_key, x.name_key) = coalesce(st.name_key, s.name_key)
        and coalesce(xst.dob, x.dob) = coalesce(st.dob, s.dob)
    ), '[]'::jsonb)
  )
  from (select 1) one
  left join students st on st.id = s.student_id;
$$;

-- Effective private lookup override with cross-class conflicts included.
create or replace function api_student_class(
  student_key text,
  class_id text,
  student_name text,
  dob date
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c classes;
  target_key text := name_key(api_student_class.student_name);
  matched boolean;
begin
  perform require_student(student_key);
  if target_key = '' or api_student_class.dob is null then
    raise exception 'Nhap ho ten va ngay sinh de tra cuu';
  end if;
  select * into c from classes
  where classes.id = api_student_class.class_id and not classes.archived;
  if not found then raise exception 'Khong tim thay lop'; end if;

  select exists (
    select 1 from submissions s
    left join students st on st.id = s.student_id
    where s.class_id = c.id and s.status = 'approved'
      and coalesce(st.name_key, s.name_key) = target_key
      and coalesce(st.dob, s.dob) = api_student_class.dob
  ) into matched;

  return jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'sessions', c.sessions,
    'currentSlots', case when matched then to_jsonb(c.current_slots) else '[]'::jsonb end,
    'finalSubjects', case when matched then c.final_subjects else '{}'::jsonb end,
    'canRequestChange', matched,
    'submissions', case when matched then coalesce((
      select jsonb_agg(jsonb_build_object(
        'studentName', coalesce(st.student_name, s.student_name),
        'displayName', coalesce(st.student_name, s.student_name),
        'dob', coalesce(st.dob, s.dob)::text,
        'busySlots', s.busy_slots,
        'otherClassSlots', submission_other_class_slots(s),
        'status', s.status,
        'updatedAt', s.updated_at,
        'canEdit', true
      ) order by lower(coalesce(st.student_name, s.student_name)), coalesce(st.student_name, s.student_name), coalesce(st.dob, s.dob))
      from submissions s
      left join students st on st.id = s.student_id
      where s.class_id = c.id and s.status = 'approved'
        and coalesce(st.name_key, s.name_key) = target_key
        and coalesce(st.dob, s.dob) = api_student_class.dob
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

grant execute on all functions in schema public to anon;


-- Trash for deleted pending submissions.
create table if not exists deleted_submissions (
  id uuid primary key default gen_random_uuid(),
  original_submission_id uuid,
  class_id text not null references classes(id) on delete cascade,
  student_id uuid references students(id) on delete set null,
  student_name text not null,
  name_key text not null,
  dob date not null,
  busy_slots text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved')),
  deleted_at timestamptz not null default now()
);

alter table deleted_submissions enable row level security;
drop policy if exists "deny direct deleted_submissions" on deleted_submissions;
create policy "deny direct deleted_submissions"
  on deleted_submissions for all using (false) with check (false);

create index if not exists deleted_submissions_deleted_at_idx on deleted_submissions (deleted_at desc);
create index if not exists deleted_submissions_class_idx on deleted_submissions (class_id);

create or replace function deleted_submission_json(d deleted_submissions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', d.id,
    'classId', d.class_id,
    'className', coalesce(c.name, d.class_id),
    'sessions', coalesce(c.sessions, array[]::text[]),
    'studentName', d.student_name,
    'dob', d.dob::text,
    'busySlots', d.busy_slots,
    'status', d.status,
    'deletedAt', d.deleted_at::text
  )
  from classes c
  where c.id = d.class_id;
$$;

create or replace function api_deleted_submissions(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  return coalesce((
    select jsonb_agg(deleted_submission_json(d) order by d.deleted_at desc)
    from deleted_submissions d
  ), '[]'::jsonb);
end;
$$;

create or replace function api_restore_deleted_submission(teacher_key text, deleted_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d deleted_submissions;
begin
  perform require_owner(teacher_key);
  select * into d from deleted_submissions where id = api_restore_deleted_submission.deleted_id;
  if not found then raise exception 'Khong tim thay yeu cau da xoa'; end if;

  insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (d.class_id, d.student_id, d.student_name, d.name_key, d.dob, d.busy_slots, 'pending', now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_id = excluded.student_id,
                student_name = excluded.student_name,
                name_key = excluded.name_key,
                dob = excluded.dob,
                busy_slots = excluded.busy_slots,
                status = 'pending',
                updated_at = now();

  delete from deleted_submissions where id = d.id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_delete_deleted_submission(teacher_key text, deleted_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  delete from deleted_submissions where id = api_delete_deleted_submission.deleted_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_clear_deleted_submissions(teacher_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  delete from deleted_submissions;
  return jsonb_build_object('ok', true);
end;
$$;

-- Archive pending requests into trash before deleting. Approved students are still removed directly from class.
create or replace function api_delete_submission(teacher_key text, class_id text, student_name text, dob date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  victim submissions;
  clean_student_name text;
  clean_name_key text;
  clean_dob date;
begin
  perform require_class_manager(teacher_key, api_delete_submission.class_id);

  select * into victim
  from submissions s
  where s.class_id = api_delete_submission.class_id
    and s.name_key = name_key(api_delete_submission.student_name)
    and s.dob = api_delete_submission.dob;

  if not found then
    return jsonb_build_object('ok', true);
  end if;

  if victim.status = 'pending' then
    select coalesce(st.student_name, victim.student_name), coalesce(st.name_key, victim.name_key), coalesce(st.dob, victim.dob)
    into clean_student_name, clean_name_key, clean_dob
    from (select 1) one
    left join students st on st.id = victim.student_id;

    insert into deleted_submissions (original_submission_id, class_id, student_id, student_name, name_key, dob, busy_slots, status, deleted_at)
    values (victim.id, victim.class_id, victim.student_id, clean_student_name, clean_name_key, clean_dob, victim.busy_slots, victim.status, now());
  end if;

  delete from submissions s where s.id = victim.id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on all functions in schema public to anon;

-- Durable homeroom records (Sổ chủ nhiệm): one compact JSON document per class + record type.
-- The frontend stores only user-edited cell contents/styles; default colors/layout are generated in code.
create table if not exists homeroom_records (
  class_id text not null references classes(id) on delete cascade,
  record_type text not null check (record_type in ('LR', 'S', 'W')),
  cells jsonb not null default '{}'::jsonb,
  styles jsonb not null default '{}'::jsonb,
  lesson_count integer not null default 3 check (lesson_count between 1 and 300),
  updated_at timestamptz not null default now(),
  primary key (class_id, record_type)
);

alter table homeroom_records enable row level security;
drop policy if exists "deny direct homeroom_records" on homeroom_records;
create policy "deny direct homeroom_records" on homeroom_records for all using (false) with check (false);

drop function if exists api_homeroom_record(text, text, text);
create or replace function api_homeroom_record(teacher_key text, class_id text, record_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rec homeroom_records;
begin
  perform require_class_manager(api_homeroom_record.teacher_key, api_homeroom_record.class_id);
  if api_homeroom_record.record_type not in ('LR', 'S', 'W') then
    raise exception 'Loại sổ không hợp lệ';
  end if;

  select *
    into rec
    from homeroom_records h
    where h.class_id = api_homeroom_record.class_id
      and h.record_type = api_homeroom_record.record_type;

  if not found then
    return jsonb_build_object(
      'cells', '{}'::jsonb,
      'styles', '{}'::jsonb,
      'lessonCount', 3
    );
  end if;

  return jsonb_build_object(
    'cells', coalesce(rec.cells, '{}'::jsonb),
    'styles', coalesce(rec.styles, '{}'::jsonb),
    'lessonCount', coalesce(rec.lesson_count, 3),
    'updatedAt', rec.updated_at
  );
end;
$$;

drop function if exists api_save_homeroom_record(text, text, text, jsonb, jsonb, integer);
create or replace function api_save_homeroom_record(
  teacher_key text,
  class_id text,
  record_type text,
  cells jsonb,
  styles jsonb,
  lesson_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_lesson_count integer := greatest(1, least(coalesce(api_save_homeroom_record.lesson_count, 3), 300));
begin
  perform require_class_manager(api_save_homeroom_record.teacher_key, api_save_homeroom_record.class_id);
  if api_save_homeroom_record.record_type not in ('LR', 'S', 'W') then
    raise exception 'Loại sổ không hợp lệ';
  end if;

  insert into homeroom_records as h (class_id, record_type, cells, styles, lesson_count, updated_at)
  values (
    api_save_homeroom_record.class_id,
    api_save_homeroom_record.record_type,
    coalesce(api_save_homeroom_record.cells, '{}'::jsonb),
    coalesce(api_save_homeroom_record.styles, '{}'::jsonb),
    safe_lesson_count,
    now()
  )
  on conflict (class_id, record_type) do update
    set cells = excluded.cells,
        styles = excluded.styles,
        lesson_count = excluded.lesson_count,
        updated_at = now();

  return jsonb_build_object('ok', true, 'lessonCount', safe_lesson_count);
end;
$$;

grant execute on all functions in schema public to anon;
