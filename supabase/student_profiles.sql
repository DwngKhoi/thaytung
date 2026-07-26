-- 2026-07-26: Student codes, profiles, course history and the parent portal.
-- Safe to run repeatedly in the Supabase SQL Editor. This block is also appended
-- at the end of schema.sql so a full re-run picks it up automatically.

-- ---------------------------------------------------------------------------
-- 1) Student code: mixes the student's name initials with their birth date
--    (DDMM), eg "Lê Đăng Khôi" born 09/03 -> LDK0903. Letters+digits only,
--    globally unique (unique index + deterministic suffix on collision).
-- ---------------------------------------------------------------------------

alter table students add column if not exists code text;
create unique index if not exists students_code_key on students (code);

create or replace function strip_vietnamese(value text)
returns text
language sql
immutable
as $$
  select upper(translate(lower(coalesce(value, '')),
    'áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
  ));
$$;

create or replace function student_code_base(p_name text, p_dob date)
returns text
language plpgsql
stable
as $$
declare
  ascii_name text := regexp_replace(strip_vietnamese(clean_name(p_name)), '[^A-Z ]', '', 'g');
  words text[] := regexp_split_to_array(trim(ascii_name), '\s+');
  initials text := '';
  w text;
begin
  if array_length(words, 1) is null or (array_length(words, 1) = 1 and words[1] = '') then
    initials := 'HS';
  elsif array_length(words, 1) = 1 then
    initials := left(words[1], 3);
  else
    foreach w in array words loop
      initials := initials || left(w, 1);
    end loop;
    initials := left(initials, 4);
  end if;
  if initials = '' then initials := 'HS'; end if;
  return initials || to_char(p_dob, 'DDMM');
end;
$$;

create or replace function generate_student_code(p_name text, p_dob date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  base text := student_code_base(p_name, p_dob);
  candidate text := base;
  -- No 0/O/1/I/L so a hand-written suffix cannot be misread.
  suffix_chars constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  i int := 0;
begin
  while exists (select 1 from students st where st.code = candidate) loop
    i := i + 1;
    if i <= length(suffix_chars) then
      candidate := base || substr(suffix_chars, i, 1);
    else
      candidate := base || upper(substr(md5(base || clock_timestamp()::text), 1, 3));
    end if;
  end loop;
  return candidate;
end;
$$;

-- Assign codes to every student that does not have one yet (idempotent backfill).
do $assign_student_codes$
declare
  r record;
begin
  for r in select id, student_name, dob from students where code is null order by created_at, id loop
    update students set code = generate_student_code(r.student_name, r.dob) where id = r.id;
  end loop;
end;
$assign_student_codes$;

-- Link any legacy submissions that still miss student_id (same join as the
-- original students migration; no-op when everything is already linked).
update submissions s
set student_id = st.id
from students st
where s.student_id is null
  and st.name_key = s.name_key
  and st.dob = s.dob;

-- Codes are stable once assigned: ensure_student only fills missing ones.
create or replace function ensure_student(student_name text, dob date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := title_name(student_name);
  result_id uuid;
  tries int := 0;
begin
  if clean = '' then raise exception 'Thiếu họ tên học sinh'; end if;
  if dob is null then raise exception 'Thiếu ngày sinh'; end if;

  insert into students (student_name, name_key, dob, updated_at)
  values (clean, name_key(clean), dob, now())
  on conflict on constraint students_name_key_dob_key do update
  set student_name = excluded.student_name,
      updated_at = now()
  returning id into result_id;

  while (select st.code from students st where st.id = result_id) is null and tries < 5 loop
    begin
      update students st
      set code = generate_student_code(clean, ensure_student.dob)
      where st.id = result_id and st.code is null;
      exit;
    exception when unique_violation then
      tries := tries + 1;
    end;
  end loop;

  return result_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Course history: append-only timeline per student so the "finish one
--    course, move to the next" journey survives transfers and archival.
-- ---------------------------------------------------------------------------

create table if not exists student_class_history (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  class_id text references classes(id) on delete set null,
  class_name text not null,
  event text not null check (event in ('enrolled', 'started', 'completed', 'transferred', 'removed')),
  note text not null default '',
  happened_at timestamptz not null default now()
);

create index if not exists student_class_history_student_idx
  on student_class_history (student_id, happened_at desc);

alter table student_class_history enable row level security;
drop policy if exists "deny direct student_class_history" on student_class_history;
create policy "deny direct student_class_history"
  on student_class_history for all using (false) with check (false);

create or replace function record_student_history(
  p_student_id uuid,
  p_class_id text,
  p_event text,
  p_note text default '',
  p_once boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cname text;
begin
  if p_student_id is null or p_class_id is null then return; end if;
  select c.name into cname from classes c where c.id = p_class_id;
  if cname is null then return; end if;
  if p_once and exists (
    select 1 from student_class_history h
    where h.student_id = p_student_id and h.class_id = p_class_id and h.event = p_event
  ) then
    return;
  end if;
  -- Double-click guard: skip identical events recorded within the last minute.
  if exists (
    select 1 from student_class_history h
    where h.student_id = p_student_id and h.class_id = p_class_id and h.event = p_event
      and h.happened_at > now() - interval '1 minute'
  ) then
    return;
  end if;
  insert into student_class_history (student_id, class_id, class_name, event, note)
  values (p_student_id, p_class_id, cname, p_event, left(coalesce(p_note, ''), 200));
end;
$$;

-- Seed the timeline from existing data (idempotent): every approved student
-- gets a 'started' entry at their submission time, archived classes count as
-- completed courses.
insert into student_class_history (student_id, class_id, class_name, event, note, happened_at)
select s.student_id, c.id, c.name, 'started', '', s.updated_at
from submissions s
join classes c on c.id = s.class_id
where s.student_id is not null and s.status = 'approved'
  and not exists (
    select 1 from student_class_history h
    where h.student_id = s.student_id and h.class_id = c.id and h.event = 'started'
  );

insert into student_class_history (student_id, class_id, class_name, event, note)
select s.student_id, c.id, c.name, 'completed', ''
from submissions s
join classes c on c.id = s.class_id
where s.student_id is not null and s.status = 'approved' and c.archived
  and not exists (
    select 1 from student_class_history h
    where h.student_id = s.student_id and h.class_id = c.id and h.event = 'completed'
  );

-- ---------------------------------------------------------------------------
-- 3) Student profiles: owner-defined custom fields (entrance score, notes...)
--    with a per-field "parents can see this" switch, values stored as jsonb.
-- ---------------------------------------------------------------------------

create table if not exists student_profile_fields (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'select')),
  options jsonb not null default '[]'::jsonb,
  visible_to_parent boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists student_profiles (
  student_id uuid primary key references students(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table student_profile_fields enable row level security;
alter table student_profiles enable row level security;
drop policy if exists "deny direct student_profile_fields" on student_profile_fields;
drop policy if exists "deny direct student_profiles" on student_profiles;
create policy "deny direct student_profile_fields"
  on student_profile_fields for all using (false) with check (false);
create policy "deny direct student_profiles"
  on student_profiles for all using (false) with check (false);

-- Starter field so the profile tab is not empty on first open.
insert into student_profile_fields (label, field_type, visible_to_parent, sort_order)
select 'Điểm đầu vào', 'number', true, 0
where not exists (select 1 from student_profile_fields);

create or replace function profile_fields_json()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id,
      'label', f.label,
      'fieldType', f.field_type,
      'options', f.options,
      'visibleToParent', f.visible_to_parent,
      'sortOrder', f.sort_order
    ) order by f.sort_order, f.created_at, f.id)
    from student_profile_fields f
  ), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- 4) Parent lookup throttle: blunt brute-force protection per caller IP.
-- ---------------------------------------------------------------------------

create table if not exists parent_lookups (
  id bigint generated always as identity primary key,
  ip text not null default '',
  code text not null default '',
  success boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists parent_lookups_ip_time_idx on parent_lookups (ip, attempted_at desc);

alter table parent_lookups enable row level security;
drop policy if exists "deny direct parent_lookups" on parent_lookups;
create policy "deny direct parent_lookups"
  on parent_lookups for all using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 5) Teacher RPCs: profile fields, student search, profile read/write.
-- ---------------------------------------------------------------------------

create or replace function api_profile_fields(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(teacher_key);
  return profile_fields_json();
end;
$$;

create or replace function api_save_profile_field(teacher_key text, field jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid := nullif(field->>'id', '')::uuid;
  flabel text := left(clean_name(field->>'label'), 80);
  ftype text := coalesce(nullif(clean_name(field->>'fieldType'), ''), 'text');
  fvisible boolean := coalesce((field->>'visibleToParent')::boolean, false);
  fsort int := coalesce((field->>'sortOrder')::int, 0);
  fopts jsonb;
begin
  perform require_owner(teacher_key);
  if flabel = '' then raise exception 'Nhập tên trường thông tin'; end if;
  if ftype not in ('text', 'number', 'date', 'select') then
    raise exception 'Kiểu trường không hợp lệ';
  end if;
  select coalesce(jsonb_agg(left(clean_name(value), 60)), '[]'::jsonb)
  into fopts
  from jsonb_array_elements_text(
    case when jsonb_typeof(field->'options') = 'array' then field->'options' else '[]'::jsonb end
  ) as t(value)
  where clean_name(value) <> '';

  if fid is null then
    insert into student_profile_fields (label, field_type, options, visible_to_parent, sort_order)
    values (flabel, ftype, fopts, fvisible, fsort)
    returning id into fid;
  else
    update student_profile_fields f
    set label = flabel, field_type = ftype, options = fopts,
        visible_to_parent = fvisible, sort_order = fsort
    where f.id = fid;
    if not found then raise exception 'Không tìm thấy trường thông tin'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', fid);
end;
$$;

create or replace function api_delete_profile_field(teacher_key text, field_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_owner(teacher_key);
  delete from student_profile_fields f where f.id = api_delete_profile_field.field_id;
  update student_profiles p
  set data = p.data - api_delete_profile_field.field_id::text, updated_at = now()
  where p.data ? api_delete_profile_field.field_id::text;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function student_classes_json(st students)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'status', s.status,
      'archived', c.archived
    ) order by c.archived, lower(c.name), c.name, c.id)
    from submissions s
    join classes c on c.id = s.class_id
    where s.student_id = st.id
       or (s.student_id is null and s.name_key = st.name_key and s.dob = st.dob)
  ), '[]'::jsonb);
$$;

create or replace function teacher_can_view_student(teacher_key text, st students)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select session_role(teacher_key) = 'owner'
    or exists (
      select 1 from submissions s
      join teacher_class_assignments a
        on a.class_id = s.class_id and a.teacher_id = session_teacher_id(teacher_key)
      where s.student_id = st.id
         or (s.student_id is null and s.name_key = st.name_key and s.dob = st.dob)
    );
$$;

create or replace function api_search_students(teacher_key text, query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := clean_name(coalesce(query, ''));
  qkey text := name_key(coalesce(query, ''));
  qcode text := upper(regexp_replace(coalesce(query, ''), '\s', '', 'g'));
begin
  perform require_teacher(teacher_key);
  return coalesce((
    select jsonb_agg(row_json)
    from (
      select jsonb_build_object(
        'id', st.id,
        'code', st.code,
        'name', st.student_name,
        'dob', st.dob::text,
        'classes', student_classes_json(st)
      ) as row_json
      from students st
      where (
          q = ''
          or (qcode <> '' and st.code like qcode || '%')
          or (qkey <> '' and st.name_key like '%' || qkey || '%')
          or (q <> '' and strip_vietnamese(st.student_name) like '%' || strip_vietnamese(q) || '%')
        )
        and teacher_can_view_student(teacher_key, st)
      order by st.updated_at desc, lower(st.student_name), st.student_name
      limit 30
    ) rows
  ), '[]'::jsonb);
end;
$$;

create or replace function api_student_profile(teacher_key text, student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  st students;
begin
  perform require_teacher(teacher_key);
  select * into st from students s where s.id = api_student_profile.student_id;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  if not teacher_can_view_student(teacher_key, st) then
    raise exception 'Không có quyền xem học sinh này';
  end if;
  return jsonb_build_object(
    'student', jsonb_build_object('id', st.id, 'code', st.code, 'name', st.student_name, 'dob', st.dob::text),
    'fields', profile_fields_json(),
    'data', coalesce((select p.data from student_profiles p where p.student_id = st.id), '{}'::jsonb),
    'classes', student_classes_json(st),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'classId', h.class_id,
        'className', h.class_name,
        'event', h.event,
        'note', h.note,
        'happenedAt', h.happened_at::text
      ) order by h.happened_at, h.id)
      from student_class_history h
      where h.student_id = st.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function api_save_student_profile(teacher_key text, student_id uuid, data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  st students;
  clean_data jsonb;
begin
  perform require_teacher(teacher_key);
  select * into st from students s where s.id = api_save_student_profile.student_id;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  if not teacher_can_view_student(teacher_key, st) then
    raise exception 'Không có quyền sửa học sinh này';
  end if;

  select coalesce(jsonb_object_agg(f.id::text, left(trim(d.value), 500)), '{}'::jsonb)
  into clean_data
  from jsonb_each_text(coalesce(api_save_student_profile.data, '{}'::jsonb)) as d(key, value)
  join student_profile_fields f on f.id::text = d.key
  where trim(coalesce(d.value, '')) <> '';

  -- Bám theo tên constraint chứ không dùng on conflict (student_id): cột này
  -- trùng tên tham số của hàm nên Postgres báo "column reference is ambiguous".
  insert into student_profiles (student_id, data, updated_at)
  values (st.id, clean_data, now())
  on conflict on constraint student_profiles_pkey do update
  set data = excluded.data, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_regenerate_student_code(teacher_key text, student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  st students;
  new_code text;
begin
  perform require_owner(teacher_key);
  select * into st from students s where s.id = api_regenerate_student_code.student_id;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;
  update students s set code = null where s.id = st.id;
  new_code := generate_student_code(st.student_name, st.dob);
  update students s set code = new_code, updated_at = now() where s.id = st.id;
  return jsonb_build_object('ok', true, 'code', new_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Parent portal RPC: one code unlocks a read-only view of the child.
-- ---------------------------------------------------------------------------

create or replace function api_parent_lookup(student_key text, code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  st students;
  clean_code text := upper(regexp_replace(coalesce(api_parent_lookup.code, ''), '\s', '', 'g'));
  req_ip text := left(coalesce(current_setting('request.headers', true)::jsonb->>'x-forwarded-for', ''), 100);
  monday date := current_date - (extract(isodow from current_date)::int - 1);
begin
  perform require_student(student_key);
  if clean_code = '' then raise exception 'Nhập mã học sinh để tra cứu'; end if;

  -- Failures are reported as {ok:false} instead of raise: an exception would
  -- roll back the parent_lookups row that feeds the throttle counter.
  if (select count(*) from parent_lookups p
      where p.ip = req_ip and not p.success
        and p.attempted_at > now() - interval '15 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau 15 phút.');
  end if;

  select * into st from students s where s.code = clean_code;
  if not found then
    delete from parent_lookups where attempted_at < now() - interval '7 days';
    insert into parent_lookups (ip, code, success) values (req_ip, left(clean_code, 20), false);
    return jsonb_build_object('ok', false, 'error', 'Không tìm thấy mã học sinh. Kiểm tra lại mã được Olympus cung cấp.');
  end if;
  insert into parent_lookups (ip, code, success) values (req_ip, left(clean_code, 20), true);

  return jsonb_build_object(
    'student', jsonb_build_object('name', st.student_name, 'code', st.code, 'dob', st.dob::text),
    'profile', coalesce((
      select jsonb_agg(jsonb_build_object(
        'label', f.label,
        'fieldType', f.field_type,
        'value', p.data->>(f.id::text)
      ) order by f.sort_order, f.created_at, f.id)
      from student_profile_fields f
      join student_profiles p on p.student_id = st.id
      where f.visible_to_parent and coalesce(p.data->>(f.id::text), '') <> ''
    ), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'sessions', c.sessions,
        'currentSlots', c.current_slots,
        'finalSubjects', c.final_subjects,
        'weekStart', monday::text,
        'weekTitle', coalesce(w.title, 'Tuần hiện tại'),
        'weekSlots', coalesce(w.slots, c.final_subjects, '{}'::jsonb),
        'activeSlots', coalesce(w.active_slots, c.current_slots),
        'weekDetails', coalesce(w.details, '{}'::jsonb)
      ) order by lower(c.name), c.name, c.id)
      from submissions s
      join classes c on c.id = s.class_id and not c.archived
      left join class_schedule_weeks w on w.class_id = c.id and w.week_start = monday
      where s.status = 'approved'
        and (s.student_id = st.id or (s.student_id is null and s.name_key = st.name_key and s.dob = st.dob))
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'classId', h.class_id,
        'className', h.class_name,
        'event', h.event,
        'note', h.note,
        'happenedAt', h.happened_at::text
      ) order by h.happened_at, h.id)
      from student_class_history h
      where h.student_id = st.id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) History hooks + student code exposure on existing RPCs. These override
--    the earlier definitions, so keep this whole block at the end of schema.sql.
-- ---------------------------------------------------------------------------

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
  was_new boolean;
begin
  sid := ensure_student(clean, p_dob);
  select array(select unnest(coalesce(p_busy_slots, '{}')) except select unnest(c.current_slots))
    into allowed_busy from classes c where c.id = p_class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  select not exists (
    select 1 from submissions s
    where s.class_id = p_class_id and s.name_key = name_key(clean) and s.dob = p_dob
  ) into was_new;
  insert into submissions (class_id, student_id, student_name, name_key, dob, busy_slots, status, updated_at)
  values (p_class_id, sid, clean, name_key(clean), p_dob, coalesce(allowed_busy, '{}'), p_status, now())
  on conflict on constraint submissions_class_id_name_key_dob_key
  do update set student_id = excluded.student_id, student_name = excluded.student_name, name_key = excluded.name_key, busy_slots = excluded.busy_slots, status = excluded.status, updated_at = now();
  if was_new then
    perform record_student_history(sid, p_class_id, 'enrolled', '', true);
  end if;
  if p_status = 'approved' then
    perform record_student_history(sid, p_class_id, 'started', '', true);
  end if;
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
  perform record_student_history(sid, api_add_student.class_id, 'enrolled', '', true);
  perform record_student_history(sid, api_add_student.class_id, 'started', '', true);
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
  if api_set_submission_status.status = 'approved' then
    perform record_student_history(sid, api_set_submission_status.class_id, 'enrolled', '', true);
    perform record_student_history(sid, api_set_submission_status.class_id, 'started', '', true);
  end if;
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
  target_names text;
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
    perform record_student_history(sid, target_id, 'enrolled', '', true);
    if source.status = 'approved' then
      perform record_student_history(sid, target_id, 'started', '', true);
    end if;
  end loop;

  if not (api_transfer_submission.class_id = any(api_transfer_submission.target_class_ids)) then
    select string_agg(c.name, ', ' order by lower(c.name)) into target_names
    from classes c where c.id = any(api_transfer_submission.target_class_ids);
    perform record_student_history(sid, api_transfer_submission.class_id, 'transferred', coalesce('→ ' || target_names, ''));
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
  prev_class_ids text[];
  removed_id text;
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

  select coalesce(array_agg(distinct s.class_id), '{}') into prev_class_ids
  from submissions s
  where s.student_id in (source_student_id, target_student_id)
     or (s.student_id is null and s.name_key = name_key(api_update_student_profile_classes.old_student_name) and s.dob = api_update_student_profile_classes.old_dob);

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
    if not (target_id = any(prev_class_ids)) then
      perform record_student_history(target_student_id, target_id, 'enrolled', '', true);
      perform record_student_history(target_student_id, target_id, 'started', '', true);
    end if;
  end loop;

  foreach removed_id in array prev_class_ids loop
    if can_access_class(teacher_key, removed_id) and not (removed_id = any(api_update_student_profile_classes.class_ids)) then
      perform record_student_history(target_student_id, removed_id, 'removed', '');
    end if;
  end loop;

  delete from submissions s
  where s.student_id = target_student_id
    and can_access_class(teacher_key, s.class_id)
    and not (s.class_id = any(api_update_student_profile_classes.class_ids));

  return jsonb_build_object('ok', true);
end; $$;

-- Deleting: pending rejections erase their 'enrolled' trace (the student never
-- actually joined); removing an approved student records 'removed'.
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
  sid uuid;
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

  sid := coalesce(victim.student_id, (
    select st.id from students st where st.name_key = victim.name_key and st.dob = victim.dob
  ));

  if victim.status = 'pending' then
    select coalesce(st.student_name, victim.student_name), coalesce(st.name_key, victim.name_key), coalesce(st.dob, victim.dob)
    into clean_student_name, clean_name_key, clean_dob
    from (select 1) one
    left join students st on st.id = victim.student_id;

    insert into deleted_submissions (original_submission_id, class_id, student_id, student_name, name_key, dob, busy_slots, status, deleted_at)
    values (victim.id, victim.class_id, victim.student_id, clean_student_name, clean_name_key, clean_dob, victim.busy_slots, victim.status, now());

    delete from student_class_history h
    where h.student_id = sid and h.class_id = victim.class_id and h.event = 'enrolled'
      and not exists (
        select 1 from student_class_history h2
        where h2.student_id = sid and h2.class_id = victim.class_id and h2.event = 'started'
      );
  else
    perform record_student_history(sid, victim.class_id, 'removed', '');
  end if;

  delete from submissions s where s.id = victim.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Archiving a class marks the course as completed for its approved students;
-- restoring the class takes the completion back.
create or replace function api_set_archived(teacher_key text, class_id text, archived boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform require_owner(teacher_key);
  update classes set archived = api_set_archived.archived where id = api_set_archived.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  if api_set_archived.archived then
    insert into student_class_history (student_id, class_id, class_name, event, note)
    select s.student_id, c.id, c.name, 'completed', ''
    from submissions s
    join classes c on c.id = s.class_id
    where s.class_id = api_set_archived.class_id
      and s.status = 'approved'
      and s.student_id is not null
      and not exists (
        select 1 from student_class_history h
        where h.student_id = s.student_id and h.class_id = s.class_id and h.event = 'completed'
      );
  else
    delete from student_class_history h
    where h.class_id = api_set_archived.class_id and h.event = 'completed';
  end if;
  return jsonb_build_object('ok', true);
end; $$;

-- Teacher class view now carries the student code for each row.
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
    'code', st.code,
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

-- Student lookup also returns the student's own code so they can share it.
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
    'studentCode', case when matched then (
      select st.code from students st
      where st.name_key = target_key and st.dob = api_student_class.dob
    ) else null end,
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

-- Internal helpers stay server-side only.
revoke execute on function record_student_history(uuid, text, text, text, boolean) from anon;
revoke execute on function generate_student_code(text, date) from anon;
revoke execute on function student_code_base(text, date) from anon;
revoke execute on function profile_fields_json() from anon;
revoke execute on function student_classes_json(students) from anon;
revoke execute on function teacher_can_view_student(text, students) from anon;
