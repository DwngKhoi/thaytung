-- OLYMPUS ALL IN ONE - UPGRADE EXISTING PROJECT
-- Dan toan bo file nay vao mot Supabase SQL Editor query va bam Run mot lan.
-- Co the chay lai; khong xoa lop, hoc sinh hay cac tuan lich hien co.

begin;


-- ============================================================================
-- student_profiles.sql
-- ============================================================================

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


-- ============================================================================
-- homeroom_records.sql
-- ============================================================================

-- Run this block in Supabase SQL Editor to enable durable homeroom records.

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
    raise exception 'Invalid homeroom record type';
  end if;

  select * into rec
  from homeroom_records h
  where h.class_id = api_homeroom_record.class_id
    and h.record_type = api_homeroom_record.record_type;

  if not found then
    return jsonb_build_object('cells', '{}'::jsonb, 'styles', '{}'::jsonb, 'lessonCount', 3);
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
    raise exception 'Invalid homeroom record type';
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


-- ============================================================================
-- attendance_profile.sql
-- ============================================================================

-- 2026-07-26: editable student identity + compact teacher attendance/payroll rows.
-- Safe to run repeatedly in Supabase SQL Editor.

create table if not exists attendance_entries (
  class_id text not null references classes(id) on delete cascade,
  record_type text not null check (record_type in ('LR', 'S', 'W')),
  lesson_index integer not null check (lesson_index between 0 and 299),
  data jsonb not null default '{}'::jsonb,
  updated_by uuid references teacher_accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (class_id, record_type, lesson_index)
);

alter table attendance_entries enable row level security;
drop policy if exists "deny direct attendance_entries" on attendance_entries;
create policy "deny direct attendance_entries"
  on attendance_entries for all using (false) with check (false);

create or replace function api_update_student_identity(
  teacher_key text,
  student_id uuid,
  new_name text,
  new_dob date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := title_name(api_update_student_identity.new_name);
  duplicate_id uuid;
begin
  perform require_teacher(api_update_student_identity.teacher_key);
  if clean = '' or api_update_student_identity.new_dob is null then
    raise exception 'Nhập đủ họ tên và ngày sinh';
  end if;

  if not exists (
    select 1
    from submissions s
    where s.student_id = api_update_student_identity.student_id
      and can_access_class(api_update_student_identity.teacher_key, s.class_id)
  ) then
    raise exception 'Không có quyền sửa học sinh này';
  end if;

  select st.id into duplicate_id
  from students st
  where st.name_key = name_key(clean)
    and st.dob = api_update_student_identity.new_dob
    and st.id <> api_update_student_identity.student_id
  limit 1;
  if duplicate_id is not null then
    raise exception 'Đã có học sinh khác trùng họ tên và ngày sinh';
  end if;

  update students st
  set student_name = clean,
      name_key = name_key(clean),
      dob = api_update_student_identity.new_dob,
      updated_at = now()
  where st.id = api_update_student_identity.student_id;
  if not found then raise exception 'Không tìm thấy học sinh'; end if;

  update submissions s
  set student_name = clean,
      name_key = name_key(clean),
      dob = api_update_student_identity.new_dob,
      updated_at = now()
  where s.student_id = api_update_student_identity.student_id;

  return jsonb_build_object('ok', true, 'name', clean, 'dob', api_update_student_identity.new_dob);
end;
$$;

create or replace function api_attendance_rows(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_teacher(api_attendance_rows.teacher_key);

  with lesson_rows as (
    select
      c.id as class_id,
      c.name as class_name,
      h.record_type,
      g.lesson_index,
      h.cells,
      (case when h.record_type = 'LR' then 2 else 6 end) as meta_rows,
      (3 + g.lesson_index * 4) as attendance_col,
      coalesce(nullif(h.cells ->> ('0|' || (3 + g.lesson_index * 4)::text), ''),
               'B' || (g.lesson_index + 1)::text) as lesson_title,
      coalesce(nullif(h.cells ->> ('0|' || (4 + g.lesson_index * 4)::text), ''),
               h.record_type || (g.lesson_index + 1)::text) as lesson_label,
      coalesce(h.cells ->> ('0|' || (5 + g.lesson_index * 4)::text), '') as record_date,
      coalesce(h.cells ->> ('0|' || (6 + g.lesson_index * 4)::text), '') as record_teacher
    from homeroom_records h
    join classes c on c.id = h.class_id and not c.archived
    cross join lateral generate_series(0, greatest(0, h.lesson_count - 1)) as g(lesson_index)
    where can_access_class(api_attendance_rows.teacher_key, c.id)
  ),
  expanded as (
    select
      lr.*,
      coalesce(counts.student_count, 0) as student_count,
      coalesce(counts.present_count, 0) as present_count,
      coalesce(counts.absent_count, 0) as absent_count,
      coalesce(ae.data, '{}'::jsonb) as entry,
      ae.updated_at,
      coalesce(ta.display_name, '') as updated_by
    from lesson_rows lr
    left join lateral (
      select
        count(*)::integer as student_count,
        count(*) filter (where roster.mark in ('TRUE', 'P', 'X', 'CÓ', 'CÓ MẶT', '1'))::integer as present_count,
        count(*) filter (where roster.mark in ('FALSE', 'V', 'VẮNG', 'A', '0'))::integer as absent_count
      from (
        select upper(trim(coalesce(
          lr.cells ->> (
            (lr.meta_rows + row_number() over (order by lower(s.student_name), s.student_name, s.dob) - 1)::text
            || '|' || lr.attendance_col::text
          ), ''
        ))) as mark
        from submissions s
        where s.class_id = lr.class_id and s.status = 'approved'
      ) roster
    ) counts on true
    left join attendance_entries ae
      on ae.class_id = lr.class_id
      and ae.record_type = lr.record_type
      and ae.lesson_index = lr.lesson_index
    left join teacher_accounts ta on ta.id = ae.updated_by
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'classId', e.class_id,
      'className', e.class_name,
      'recordType', e.record_type,
      'lessonIndex', e.lesson_index,
      'lessonTitle', e.lesson_title,
      'lessonLabel', e.lesson_label,
      'recordDate', e.record_date,
      'recordTeacher', e.record_teacher,
      'studentCount', e.student_count,
      'presentCount', e.present_count,
      'absentCount', e.absent_count,
      'entry', e.entry,
      'updatedAt', e.updated_at,
      'updatedBy', e.updated_by
    )
    order by lower(e.class_name), e.class_name,
      case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
      e.lesson_index
  ), '[]'::jsonb)
  into result
  from expanded e;

  return result;
end;
$$;

create or replace function api_save_attendance_entry(
  teacher_key text,
  class_id text,
  record_type text,
  lesson_index integer,
  entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_entry jsonb;
  clean_status text := left(clean_name(api_save_attendance_entry.entry ->> 'status'), 30);
begin
  perform require_class_manager(api_save_attendance_entry.teacher_key, api_save_attendance_entry.class_id);
  if api_save_attendance_entry.record_type not in ('LR', 'S', 'W')
     or api_save_attendance_entry.lesson_index not between 0 and 299 then
    raise exception 'Buổi học không hợp lệ';
  end if;
  if clean_status not in ('', 'Chưa chốt', 'Đã dạy', 'Dạy bù', 'Nghỉ') then
    clean_status := 'Chưa chốt';
  end if;

  clean_entry := jsonb_build_object(
    'lessonDate', left(clean_name(api_save_attendance_entry.entry ->> 'lessonDate'), 10),
    'teacherName', left(clean_name(api_save_attendance_entry.entry ->> 'teacherName'), 120),
    'startTime', left(clean_name(api_save_attendance_entry.entry ->> 'startTime'), 5),
    'endTime', left(clean_name(api_save_attendance_entry.entry ->> 'endTime'), 5),
    'periods', left(clean_name(api_save_attendance_entry.entry ->> 'periods'), 8),
    'status', coalesce(nullif(clean_status, ''), 'Chưa chốt'),
    'note', left(clean_name(api_save_attendance_entry.entry ->> 'note'), 1000)
  );

  insert into attendance_entries as ae
    (class_id, record_type, lesson_index, data, updated_by, updated_at)
  values (
    api_save_attendance_entry.class_id,
    api_save_attendance_entry.record_type,
    api_save_attendance_entry.lesson_index,
    clean_entry,
    session_teacher_id(api_save_attendance_entry.teacher_key),
    now()
  )
  on conflict on constraint attendance_entries_pkey do update
    set data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = now();

  return jsonb_build_object('ok', true, 'entry', clean_entry);
end;
$$;

grant execute on function api_update_student_identity(text, uuid, text, date) to anon;
grant execute on function api_attendance_rows(text) to anon;
grant execute on function api_save_attendance_entry(text, text, text, integer, jsonb) to anon;


-- ============================================================================
-- vocab_schedule_sync.sql
-- ============================================================================

-- 2026-07-26: owner-managed vocabulary + Schedule -> Homeroom -> Attendance sync.
-- Safe to run repeatedly after schema.sql or attendance_profile.sql.

-- ---------------------------------------------------------------------------
-- Teacher dropdown: expose display names only, never usernames/passwords.
-- ---------------------------------------------------------------------------
create or replace function api_teacher_directory(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(api_teacher_directory.teacher_key);
  return jsonb_build_array(jsonb_build_object('name', 'Thầy Tùng', 'role', 'owner'))
    || coalesce((
      select jsonb_agg(jsonb_build_object('name', a.display_name, 'role', 'teacher')
                       order by lower(a.display_name), a.display_name, a.id)
      from teacher_accounts a
      where a.active
    ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Vocabulary overrides. The 520 bundled words remain static; this table only
-- stores owner additions and compact tombstones for bundled words being hidden.
-- ---------------------------------------------------------------------------
create table if not exists vocabulary_customizations (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  unit_no integer not null check (unit_no between 1 and 100),
  action text not null check (action in ('add', 'remove')),
  word_key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists vocabulary_remove_unique
  on vocabulary_customizations (book_id, unit_no, word_key)
  where action = 'remove';

alter table vocabulary_customizations enable row level security;
drop policy if exists "deny direct vocabulary_customizations" on vocabulary_customizations;
create policy "deny direct vocabulary_customizations"
  on vocabulary_customizations for all using (false) with check (false);

create or replace function api_vocabulary_customizations(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_teacher(api_vocabulary_customizations.teacher_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id,
      'bookId', v.book_id,
      'unitNo', v.unit_no,
      'action', v.action,
      'wordKey', v.word_key,
      'data', v.data
    ) order by v.created_at, v.id)
    from vocabulary_customizations v
  ), '[]'::jsonb);
end;
$$;

create or replace function api_add_vocabulary_word(
  teacher_key text,
  book_id text,
  unit_no integer,
  word jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_word text := left(clean_name(api_add_vocabulary_word.word ->> 'w'), 120);
  clean_key text;
  clean_data jsonb;
  new_id uuid;
begin
  perform require_owner(api_add_vocabulary_word.teacher_key);
  if clean_word = '' or clean_name(api_add_vocabulary_word.word ->> 'vn') = '' then
    raise exception 'Cần nhập từ và nghĩa tiếng Việt';
  end if;
  if clean_name(api_add_vocabulary_word.book_id) = ''
     or api_add_vocabulary_word.unit_no not between 1 and 100 then
    raise exception 'Giáo trình hoặc Unit không hợp lệ';
  end if;

  clean_key := lower(clean_word);
  clean_data := jsonb_build_object(
    'w', clean_word,
    't', left(clean_name(api_add_vocabulary_word.word ->> 't'), 30),
    'ipa', left(clean_name(api_add_vocabulary_word.word ->> 'ipa'), 120),
    'vn', left(clean_name(api_add_vocabulary_word.word ->> 'vn'), 300),
    'ex', left(clean_name(api_add_vocabulary_word.word ->> 'ex'), 500)
  );

  delete from vocabulary_customizations v
  where v.book_id = api_add_vocabulary_word.book_id
    and v.unit_no = api_add_vocabulary_word.unit_no
    and v.word_key = clean_key
    and v.action = 'remove';

  insert into vocabulary_customizations (book_id, unit_no, action, word_key, data)
  values (left(clean_name(api_add_vocabulary_word.book_id), 60),
          api_add_vocabulary_word.unit_no, 'add', clean_key, clean_data)
  returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'data', clean_data);
end;
$$;

create or replace function api_remove_vocabulary_word(
  teacher_key text,
  book_id text,
  unit_no integer,
  word_key text,
  custom_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_key text := lower(left(clean_name(api_remove_vocabulary_word.word_key), 120));
begin
  perform require_owner(api_remove_vocabulary_word.teacher_key);
  if api_remove_vocabulary_word.custom_id is not null then
    delete from vocabulary_customizations v
    where v.id = api_remove_vocabulary_word.custom_id and v.action = 'add';
  else
    insert into vocabulary_customizations (book_id, unit_no, action, word_key, data)
    values (left(clean_name(api_remove_vocabulary_word.book_id), 60),
            api_remove_vocabulary_word.unit_no, 'remove', clean_key, '{}'::jsonb)
    on conflict (book_id, unit_no, word_key) where action = 'remove' do nothing;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Extended schedule metadata. It is saved separately so this migration works
-- even when the older api_save_schedule_week RPC is still installed.
-- ---------------------------------------------------------------------------
create or replace function api_save_schedule_extra_details(
  teacher_key text,
  class_id text,
  week_start date,
  details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_details jsonb;
begin
  perform require_class_manager(api_save_schedule_extra_details.teacher_key,
                                api_save_schedule_extra_details.class_id);
  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120)
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_extra_details.details, '{}'::jsonb)) d
  where d.key ~ '^[0-6]-[0-9]+$';

  update class_schedule_weeks w
  set details = clean_details,
      updated_at = now()
  where w.class_id = api_save_schedule_extra_details.class_id
    and w.week_start = api_save_schedule_extra_details.week_start;
  if not found then raise exception 'Không tìm thấy tuần vừa lưu'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_homeroom_schedule_sync(
  teacher_key text,
  class_id text,
  record_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_class_manager(api_homeroom_schedule_sync.teacher_key,
                                api_homeroom_schedule_sync.class_id);
  if api_homeroom_schedule_sync.record_type not in ('LR', 'S', 'W') then
    raise exception 'Loại sổ không hợp lệ';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lessonLabel', q.lesson_label,
    'lessonDate', q.lesson_date::text,
    'dayName', q.day_name,
    'sessionName', q.session_name,
    'startTime', q.start_time,
    'teacherName', q.teacher_name,
    'location', q.location,
    'note', q.note
  ) order by q.lesson_date, q.session_index, q.lesson_label), '[]'::jsonb)
  into result
  from (
    select
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      (array['Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ nhật'])
        [split_part(slot.key, '-', 1)::integer + 1] as day_name,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(c.sessions[split_part(slot.key, '-', 2)::integer + 1], '') as session_name,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name,
      coalesce(w.details -> slot.key ->> 'location', '') as location,
      coalesce(w.details -> slot.key ->> 'note', '') as note
    from class_schedule_weeks w
    join classes c on c.id = w.class_id
    cross join lateral jsonb_each_text(w.slots) slot
    where w.class_id = api_homeroom_schedule_sync.class_id
      and slot.value ~ ('^' || api_homeroom_schedule_sync.record_type || '[0-9]+$')
  ) q;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attendance source: union saved homeroom lessons with lessons found in the
-- weekly schedule. Metadata prefers an explicit homeroom edit, then schedule.
-- ---------------------------------------------------------------------------
create table if not exists attendance_entries (
  class_id text not null references classes(id) on delete cascade,
  record_type text not null check (record_type in ('LR', 'S', 'W')),
  lesson_index integer not null check (lesson_index between 0 and 299),
  data jsonb not null default '{}'::jsonb,
  updated_by uuid references teacher_accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (class_id, record_type, lesson_index)
);
alter table attendance_entries enable row level security;
drop policy if exists "deny direct attendance_entries" on attendance_entries;
create policy "deny direct attendance_entries"
  on attendance_entries for all using (false) with check (false);

create or replace function api_attendance_rows(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_teacher(api_attendance_rows.teacher_key);

  with raw_schedule as (
    select
      c.id as class_id,
      c.name as class_name,
      case
        when slot.value ~ '^LR[0-9]+$' then 'LR'
        when slot.value ~ '^S[0-9]+$' then 'S'
        when slot.value ~ '^W[0-9]+$' then 'W'
      end as record_type,
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name
    from class_schedule_weeks w
    join classes c on c.id = w.class_id and not c.archived
    cross join lateral jsonb_each_text(w.slots) slot
    where slot.value ~ '^(LR|S|W)[0-9]+$'
      and can_access_class(api_attendance_rows.teacher_key, c.id)
  ),
  schedule_lessons as (
    select rs.*,
      (row_number() over (
        partition by rs.class_id, rs.record_type
        order by rs.lesson_date, rs.session_index, rs.lesson_label
      ) - 1)::integer as lesson_index
    from raw_schedule rs
  ),
  lesson_keys as (
    select h.class_id, h.record_type, g.lesson_index
    from homeroom_records h
    cross join lateral generate_series(0, greatest(0, h.lesson_count - 1)) g(lesson_index)
    where can_access_class(api_attendance_rows.teacher_key, h.class_id)
    union
    select sl.class_id, sl.record_type, sl.lesson_index from schedule_lessons sl
  ),
  expanded as (
    select
      lk.class_id,
      c.name as class_name,
      lk.record_type,
      lk.lesson_index,
      coalesce(nullif(h.cells ->> ('0|' || (3 + lk.lesson_index * 4)::text), ''),
               'B' || (lk.lesson_index + 1)::text) as lesson_title,
      coalesce(nullif(h.cells ->> ('0|' || (4 + lk.lesson_index * 4)::text), ''),
               sl.lesson_label,
               lk.record_type || (lk.lesson_index + 1)::text) as lesson_label,
      coalesce(sl.lesson_date::text,
               nullif(h.cells ->> ('0|' || (5 + lk.lesson_index * 4)::text), ''),
               '') as record_date,
      coalesce(nullif(h.cells ->> ('0|' || (6 + lk.lesson_index * 4)::text), ''),
               sl.teacher_name, '') as record_teacher,
      coalesce(sl.start_time, '') as record_start_time,
      coalesce(counts.student_count, 0) as student_count,
      coalesce(counts.present_count, 0) as present_count,
      coalesce(counts.absent_count, 0) as absent_count,
      coalesce(ae.data, '{}'::jsonb) as entry,
      ae.updated_at,
      coalesce(ta.display_name, '') as updated_by
    from lesson_keys lk
    join classes c on c.id = lk.class_id and not c.archived
    left join homeroom_records h
      on h.class_id = lk.class_id and h.record_type = lk.record_type
    left join schedule_lessons sl
      on sl.class_id = lk.class_id and sl.record_type = lk.record_type
      and sl.lesson_index = lk.lesson_index
    left join lateral (
      select
        count(*)::integer as student_count,
        count(*) filter (where roster.mark in ('TRUE','P','X','CÓ','CÓ MẶT','1'))::integer as present_count,
        count(*) filter (where roster.mark in ('FALSE','V','VẮNG','A','0'))::integer as absent_count
      from (
        select upper(trim(coalesce(
          h.cells ->> (
            ((case when lk.record_type = 'LR' then 2 else 6 end)
             + row_number() over (order by lower(s.student_name), s.student_name, s.dob) - 1)::text
            || '|' || (3 + lk.lesson_index * 4)::text
          ), ''
        ))) as mark
        from submissions s
        where s.class_id = lk.class_id and s.status = 'approved'
      ) roster
    ) counts on true
    left join attendance_entries ae
      on ae.class_id = lk.class_id and ae.record_type = lk.record_type
      and ae.lesson_index = lk.lesson_index
    left join teacher_accounts ta on ta.id = ae.updated_by
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'classId', e.class_id, 'className', e.class_name,
    'recordType', e.record_type, 'lessonIndex', e.lesson_index,
    'lessonTitle', e.lesson_title, 'lessonLabel', e.lesson_label,
    'recordDate', e.record_date, 'recordTeacher', e.record_teacher,
    'recordStartTime', e.record_start_time,
    'studentCount', e.student_count, 'presentCount', e.present_count,
    'absentCount', e.absent_count, 'entry', e.entry,
    'updatedAt', e.updated_at, 'updatedBy', e.updated_by
  ) order by lower(e.class_name), e.class_name,
    case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
    e.lesson_index), '[]'::jsonb)
  into result
  from expanded e;
  return result;
end;
$$;

create or replace function api_save_attendance_entry(
  teacher_key text,
  class_id text,
  record_type text,
  lesson_index integer,
  entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_entry jsonb;
  clean_status text := left(clean_name(api_save_attendance_entry.entry ->> 'status'), 30);
  date_text text := left(clean_name(api_save_attendance_entry.entry ->> 'lessonDate'), 10);
  teacher_text text := left(clean_name(api_save_attendance_entry.entry ->> 'teacherName'), 120);
begin
  perform require_class_manager(api_save_attendance_entry.teacher_key,
                                api_save_attendance_entry.class_id);
  if api_save_attendance_entry.record_type not in ('LR','S','W')
     or api_save_attendance_entry.lesson_index not between 0 and 299 then
    raise exception 'Buổi học không hợp lệ';
  end if;
  if clean_status not in ('', 'Chưa chốt', 'Đã dạy', 'Dạy bù', 'Nghỉ') then
    clean_status := 'Chưa chốt';
  end if;

  clean_entry := jsonb_build_object(
    'lessonDate', date_text,
    'teacherName', teacher_text,
    'startTime', left(clean_name(api_save_attendance_entry.entry ->> 'startTime'), 5),
    'endTime', left(clean_name(api_save_attendance_entry.entry ->> 'endTime'), 5),
    'periods', left(clean_name(api_save_attendance_entry.entry ->> 'periods'), 8),
    'status', coalesce(nullif(clean_status, ''), 'Chưa chốt'),
    'note', left(clean_name(api_save_attendance_entry.entry ->> 'note'), 1000)
  );

  insert into attendance_entries as ae
    (class_id, record_type, lesson_index, data, updated_by, updated_at)
  values (api_save_attendance_entry.class_id, api_save_attendance_entry.record_type,
          api_save_attendance_entry.lesson_index, clean_entry,
          session_teacher_id(api_save_attendance_entry.teacher_key), now())
  on conflict on constraint attendance_entries_pkey do update
    set data = excluded.data, updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('ok', true, 'entry', clean_entry);
end;
$$;

grant execute on function api_teacher_directory(text) to anon;
grant execute on function api_vocabulary_customizations(text) to anon;
grant execute on function api_add_vocabulary_word(text, text, integer, jsonb) to anon;
grant execute on function api_remove_vocabulary_word(text, text, integer, text, uuid) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_homeroom_schedule_sync(text, text, text) to anon;
grant execute on function api_attendance_rows(text) to anon;
grant execute on function api_save_attendance_entry(text, text, text, integer, jsonb) to anon;


-- ============================================================================
-- submission_timestamps.sql
-- ============================================================================

-- Run this block in Supabase SQL Editor to show timestamps on pending submissions.

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

grant execute on all functions in schema public to anon;


-- ============================================================================
-- schedule_v2.sql
-- ============================================================================

-- Olympus schedule v2
-- Run this file once in Supabase SQL Editor after schema.sql / vocab_schedule_sync.sql.

alter table classes
  add column if not exists course_kind text not null default 'skills';
alter table classes
  add column if not exists current_schedule_week date;

update classes
set course_kind = 'grammar'
where course_kind = 'skills'
  and (
    name ~* '^G[0-9]+'
    or sector_id in (
      select cs.id from class_sectors cs
      where lower(cs.name) like '%ngữ pháp%'
    )
  );

update classes
set lesson_starts =
  '{"S":1,"W":1,"LR":1,"L":1,"R":1,"COURSE":1}'::jsonb
  || coalesce(lesson_starts, '{}'::jsonb);

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
    'finalDetails', coalesce((
      select w.details
      from class_schedule_weeks w
      where w.class_id = c.id
      order by
        case when w.week_start = c.current_schedule_week then 0 else 1 end,
        w.week_start desc
      limit 1
    ), '{}'::jsonb),
    'courseKind', c.course_kind,
    'lessonStarts', c.lesson_starts,
    'sectorId', c.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
    'approvedCount', (
      select count(*) from submissions s
      where s.class_id = c.id and s.status = 'approved'
    ),
    'pendingCount', (
      select count(*) from submissions s
      where s.class_id = c.id and s.status = 'pending'
    )
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
  target classes;
begin
  perform require_teacher(api_class.teacher_key);
  if not can_access_class(api_class.teacher_key, api_class.class_id) then
    raise exception 'Không có quyền xem lớp này';
  end if;
  select c.* into target
  from classes c
  where c.id = api_class.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  return class_summary(target) || jsonb_build_object(
    'archived', target.archived,
    'submissions', coalesce((
      select jsonb_agg(
        teacher_submission_json(s)
        order by lower(coalesce(st.student_name, s.student_name)),
                 coalesce(st.student_name, s.student_name),
                 coalesce(st.dob, s.dob)
      )
      from submissions s
      left join students st on st.id = s.student_id
      where s.class_id = target.id
    ), '[]'::jsonb)
  );
end;
$$;

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
  target classes;
  monday date := current_date - (extract(isodow from current_date)::integer - 1);
  requested date := coalesce(api_schedule_class.selected_week_start, monday);
  selected_week jsonb;
  before_max jsonb;
  all_max jsonb;
  pending_before jsonb;
begin
  perform require_class_manager(api_schedule_class.teacher_key, api_schedule_class.class_id);
  select c.* into target
  from classes c
  where c.id = api_schedule_class.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select jsonb_build_object(
    'weekStart', w.week_start::text,
    'title', w.title,
    'slots', w.slots,
    'activeSlots', w.active_slots,
    'details', w.details
  )
  into selected_week
  from class_schedule_weeks w
  where w.class_id = target.id and w.week_start = requested;

  select jsonb_build_object(
    'S', coalesce(max(substring(e.value from '^S([0-9]+)$')::integer)
                  filter (where e.value ~ '^S[0-9]+$'), 0),
    'W', coalesce(max(substring(e.value from '^W([0-9]+)$')::integer)
                  filter (where e.value ~ '^W[0-9]+$'), 0),
    'LR', coalesce(max(substring(e.value from '^LR([0-9]+)$')::integer)
                   filter (where e.value ~ '^LR[0-9]+$'), 0),
    'L', coalesce(max(substring(e.value from '^L([0-9]+)$')::integer)
                  filter (where e.value ~ '^L[0-9]+$'), 0),
    'R', coalesce(max(substring(e.value from '^R([0-9]+)$')::integer)
                  filter (where e.value ~ '^R[0-9]+$'), 0),
    'COURSE', coalesce(max(
      substring(d.value ->> 'courseNo' from '^([0-9]+)')::integer
    ) filter (where coalesce(d.value ->> 'courseNo', '') ~ '^[0-9]+[ab]?$'), 0)
  )
  into before_max
  from class_schedule_weeks w
  left join lateral jsonb_each_text(w.slots) e on true
  left join lateral jsonb_each(w.details) d on d.key = e.key
  where w.class_id = target.id and w.week_start < requested;

  select jsonb_build_object(
    'S', coalesce(max(substring(e.value from '^S([0-9]+)$')::integer)
                  filter (where e.value ~ '^S[0-9]+$'), 0),
    'W', coalesce(max(substring(e.value from '^W([0-9]+)$')::integer)
                  filter (where e.value ~ '^W[0-9]+$'), 0),
    'LR', coalesce(max(substring(e.value from '^LR([0-9]+)$')::integer)
                   filter (where e.value ~ '^LR[0-9]+$'), 0),
    'L', coalesce(max(substring(e.value from '^L([0-9]+)$')::integer)
                  filter (where e.value ~ '^L[0-9]+$'), 0),
    'R', coalesce(max(substring(e.value from '^R([0-9]+)$')::integer)
                  filter (where e.value ~ '^R[0-9]+$'), 0),
    'COURSE', coalesce(max(
      substring(d.value ->> 'courseNo' from '^([0-9]+)')::integer
    ) filter (where coalesce(d.value ->> 'courseNo', '') ~ '^[0-9]+[ab]?$'), 0)
  )
  into all_max
  from class_schedule_weeks w
  left join lateral jsonb_each_text(w.slots) e on true
  left join lateral jsonb_each(w.details) d on d.key = e.key
  where w.class_id = target.id;

  select case
    when last_slot.lesson_label ~ '^(MT1|FT1)$'
      and last_slot.course_no ~ '^[0-9]+a$'
    then jsonb_build_object(
      'type', substring(last_slot.lesson_label from '^(MT|FT)'),
      'course', substring(last_slot.course_no from '^([0-9]+)')::integer
    )
    else null
  end
  into pending_before
  from (
    select
      e.value as lesson_label,
      coalesce(d.value ->> 'courseNo', '') as course_no
    from class_schedule_weeks w
    cross join lateral jsonb_each_text(w.slots) e
    left join lateral jsonb_each(w.details) d on d.key = e.key
    where w.class_id = target.id and w.week_start < requested
    order by
      w.week_start desc,
      split_part(e.key, '-', 1)::integer desc,
      split_part(e.key, '-', 2)::integer desc
    limit 1
  ) last_slot;

  return jsonb_build_object(
    'id', target.id,
    'name', target.name,
    'sessions', target.sessions,
    'currentSlots', target.current_slots,
    'finalSubjects', target.final_subjects,
    'finalDetails', coalesce((
      select w.details from class_schedule_weeks w
      where w.class_id = target.id
      order by
        case when w.week_start = target.current_schedule_week then 0 else 1 end,
        w.week_start desc
      limit 1
    ), '{}'::jsonb),
    'courseKind', target.course_kind,
    'lessonStarts', target.lesson_starts,
    'sectorId', target.sector_id,
    'sectorName', (select cs.name from class_sectors cs where cs.id = target.sector_id),
    'currentWeekStart', monday::text,
    'selectedWeekStart', requested::text,
    'selectedWeek', selected_week,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start::text,
        'title', w.title
      ) order by w.week_start desc)
      from class_schedule_weeks w
      where w.class_id = target.id
    ), '[]'::jsonb),
    'sequenceBefore', coalesce(before_max, '{}'::jsonb),
    'pendingAssessmentBefore', pending_before,
    'lessonMaximums', coalesce(all_max, '{}'::jsonb)
  );
end;
$$;

create or replace function api_save_schedule_settings(
  teacher_key text,
  class_id text,
  course_kind text,
  lesson_starts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_kind text;
  clean_starts jsonb;
begin
  perform require_class_manager(
    api_save_schedule_settings.teacher_key,
    api_save_schedule_settings.class_id
  );
  clean_kind := case
    when lower(clean_name(api_save_schedule_settings.course_kind)) = 'grammar'
    then 'grammar' else 'skills' end;
  clean_starts := jsonb_build_object(
    'S', greatest(coalesce(case when lesson_starts ->> 'S' ~ '^[0-9]+$' then (lesson_starts ->> 'S')::integer end, 1), 1),
    'W', greatest(coalesce(case when lesson_starts ->> 'W' ~ '^[0-9]+$' then (lesson_starts ->> 'W')::integer end, 1), 1),
    'LR', greatest(coalesce(case when lesson_starts ->> 'LR' ~ '^[0-9]+$' then (lesson_starts ->> 'LR')::integer end, 1), 1),
    'L', greatest(coalesce(case when lesson_starts ->> 'L' ~ '^[0-9]+$' then (lesson_starts ->> 'L')::integer end, 1), 1),
    'R', greatest(coalesce(case when lesson_starts ->> 'R' ~ '^[0-9]+$' then (lesson_starts ->> 'R')::integer end, 1), 1),
    'COURSE', greatest(coalesce(case when lesson_starts ->> 'COURSE' ~ '^[0-9]+$' then (lesson_starts ->> 'COURSE')::integer end, 1), 1)
  );
  update classes c
  set course_kind = clean_kind, lesson_starts = clean_starts
  where c.id = api_save_schedule_settings.class_id;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  return jsonb_build_object('ok', true, 'courseKind', clean_kind, 'lessonStarts', clean_starts);
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
  target classes;
  clean_sessions text[];
  clean_current text[];
  clean_slots jsonb;
  clean_details jsonb;
  clean_starts jsonb;
begin
  perform require_class_manager(api_save_schedule_week.teacher_key, api_save_schedule_week.class_id);
  select c.* into target
  from classes c
  where c.id = api_save_schedule_week.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;
  if api_save_schedule_week.week_start is null then
    raise exception 'Thiếu ngày bắt đầu tuần';
  end if;

  select coalesce(array_agg(x.value order by x.ord), '{}')
  into clean_sessions
  from (
    select min(t.ord) as ord, clean_name(t.value) as value
    from unnest(coalesce(api_save_schedule_week.sessions, '{}'))
      with ordinality t(value, ord)
    where clean_name(t.value) <> ''
    group by lower(clean_name(t.value)), clean_name(t.value)
    order by min(t.ord)
    limit 12
  ) x;
  if coalesce(array_length(clean_sessions, 1), 0) = 0 then
    raise exception 'Cần ít nhất một ca';
  end if;

  select coalesce(array_agg(v.slot order by v.day_index, v.session_index), '{}')
  into clean_current
  from (
    select distinct
      clean_name(u.value) as slot,
      split_part(clean_name(u.value), '-', 1)::integer as day_index,
      split_part(clean_name(u.value), '-', 2)::integer as session_index
    from unnest(coalesce(api_save_schedule_week.current_slots, '{}')) u(value)
    where clean_name(u.value) ~ '^[0-6]-[0-9]+$'
      and split_part(clean_name(u.value), '-', 2)::integer < array_length(clean_sessions, 1)
  ) v;

  select coalesce(jsonb_object_agg(e.key, upper(clean_name(e.value))), '{}'::jsonb)
  into clean_slots
  from jsonb_each_text(coalesce(api_save_schedule_week.week_slots, '{}'::jsonb)) e
  where e.key = any(clean_current)
    and upper(clean_name(e.value)) ~
      '^(S[0-9]+|W[0-9]+|LR[0-9]+|L[0-9]+|R[0-9]+|MT[12]?|FT[12]?|OFF|LESSON|REVIEW)$';

  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120),
    'courseNo', case
      when clean_name(d.value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(d.value ->> 'courseNo') else '' end,
    'lessonType', case
      when upper(clean_name(d.value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(d.value ->> 'lessonType')) else '' end
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_week.week_details, '{}'::jsonb)) d
  where d.key = any(clean_current);

  clean_starts := jsonb_build_object(
    'S', greatest(coalesce(case when lesson_starts ->> 'S' ~ '^[0-9]+$' then (lesson_starts ->> 'S')::integer end, 1), 1),
    'W', greatest(coalesce(case when lesson_starts ->> 'W' ~ '^[0-9]+$' then (lesson_starts ->> 'W')::integer end, 1), 1),
    'LR', greatest(coalesce(case when lesson_starts ->> 'LR' ~ '^[0-9]+$' then (lesson_starts ->> 'LR')::integer end, 1), 1),
    'L', greatest(coalesce(case when lesson_starts ->> 'L' ~ '^[0-9]+$' then (lesson_starts ->> 'L')::integer end, 1), 1),
    'R', greatest(coalesce(case when lesson_starts ->> 'R' ~ '^[0-9]+$' then (lesson_starts ->> 'R')::integer end, 1), 1),
    'COURSE', greatest(coalesce(case when lesson_starts ->> 'COURSE' ~ '^[0-9]+$' then (lesson_starts ->> 'COURSE')::integer end, 1), 1)
  );

  update classes c
  set sessions = clean_sessions,
      current_slots = clean_current,
      final_subjects = clean_slots,
      lesson_starts = clean_starts,
      current_schedule_week = api_save_schedule_week.week_start
  where c.id = target.id;

  insert into class_schedule_weeks (
    class_id, week_start, title, slots, active_slots, details, updated_at
  )
  values (
    target.id,
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

create or replace function api_save_schedule_extra_details(
  teacher_key text,
  class_id text,
  week_start date,
  details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_details jsonb;
begin
  perform require_class_manager(
    api_save_schedule_extra_details.teacher_key,
    api_save_schedule_extra_details.class_id
  );
  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120),
    'courseNo', case
      when clean_name(d.value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(d.value ->> 'courseNo') else '' end,
    'lessonType', case
      when upper(clean_name(d.value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(d.value ->> 'lessonType')) else '' end
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_extra_details.details, '{}'::jsonb)) d
  where d.key ~ '^[0-6]-[0-9]+$';

  update class_schedule_weeks w
  set details = clean_details, updated_at = now()
  where w.class_id = api_save_schedule_extra_details.class_id
    and w.week_start = api_save_schedule_extra_details.week_start;
  if not found then raise exception 'Không tìm thấy tuần vừa lưu'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function api_schedule_overview(
  teacher_key text,
  week_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_monday date := current_date - (extract(isodow from current_date)::integer - 1);
  requested date := coalesce(
    api_schedule_overview.week_start,
    current_date - (extract(isodow from current_date)::integer - 1)
  );
  result jsonb;
begin
  perform require_teacher(api_schedule_overview.teacher_key);
  with accessible as (
    select c.*
    from classes c
    where not c.archived
      and can_access_class(api_schedule_overview.teacher_key, c.id)
  ),
  week_directory as (
    select w.week_start, max(w.title) as title
    from class_schedule_weeks w
    join accessible c on c.id = w.class_id
    group by w.week_start
  )
  select jsonb_build_object(
    'weekStart', requested::text,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', wd.week_start::text,
        'title', wd.title
      ) order by wd.week_start desc)
      from week_directory wd
    ), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'sessions', c.sessions,
        'courseKind', c.course_kind,
        'lessonStarts', c.lesson_starts,
        'sectorId', c.sector_id,
        'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
        'activeSlots', coalesce(
          w.active_slots,
          case when requested = current_monday then c.current_slots else '{}'::text[] end
        ),
        'slots', coalesce(
          w.slots,
          case when requested = current_monday then c.final_subjects else '{}'::jsonb end
        ),
        'details', coalesce(
          w.details,
          case when requested = current_monday then coalesce((
            select cw.details from class_schedule_weeks cw
            where cw.class_id = c.id
            order by
              case when cw.week_start = c.current_schedule_week then 0 else 1 end,
              cw.week_start desc
            limit 1
          ), '{}'::jsonb) else '{}'::jsonb end
        )
      ) order by lower(coalesce((select cs.name from class_sectors cs where cs.id = c.sector_id), '')),
                 lower(c.name), c.name, c.id)
      from accessible c
      left join class_schedule_weeks w
        on w.class_id = c.id and w.week_start = requested
    ), '[]'::jsonb)
  )
  into result;
  return result;
end;
$$;

create or replace function api_public_schedule(student_key text, class_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target classes;
  monday date := current_date - (extract(isodow from current_date)::integer - 1);
  selected class_schedule_weeks;
begin
  perform require_student(api_public_schedule.student_key);
  select c.* into target
  from classes c
  where c.id = api_public_schedule.class_id and not c.archived;
  if not found then raise exception 'Không tìm thấy lớp'; end if;

  select w.* into selected
  from class_schedule_weeks w
  where w.class_id = target.id and w.week_start = monday;
  if not found and target.current_schedule_week is not null then
    select w.* into selected
    from class_schedule_weeks w
    where w.class_id = target.id and w.week_start = target.current_schedule_week;
  end if;

  return jsonb_build_object(
    'id', target.id,
    'name', target.name,
    'sessions', target.sessions,
    'courseKind', target.course_kind,
    'weekStart', coalesce(selected.week_start, monday)::text,
    'title', coalesce(selected.title, 'Tuần hiện tại'),
    'activeSlots', coalesce(selected.active_slots, target.current_slots),
    'slots', coalesce(selected.slots, target.final_subjects, '{}'::jsonb),
    'details', coalesce(selected.details, '{}'::jsonb)
  );
end;
$$;

create or replace function api_homeroom_schedule_sync(
  teacher_key text,
  class_id text,
  record_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_class_manager(
    api_homeroom_schedule_sync.teacher_key,
    api_homeroom_schedule_sync.class_id
  );
  if api_homeroom_schedule_sync.record_type not in ('LR', 'S', 'W') then
    raise exception 'Loại sổ không hợp lệ';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lessonLabel', q.lesson_label,
    'lessonDate', q.lesson_date::text,
    'dayName', q.day_name,
    'sessionName', q.session_name,
    'startTime', q.start_time,
    'teacherName', q.teacher_name,
    'location', q.location,
    'note', q.note
  ) order by q.lesson_date, q.session_index, q.lesson_label), '[]'::jsonb)
  into result
  from (
    select
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      (array['Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ nhật'])
        [split_part(slot.key, '-', 1)::integer + 1] as day_name,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(c.sessions[split_part(slot.key, '-', 2)::integer + 1], '') as session_name,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name,
      coalesce(w.details -> slot.key ->> 'location', '') as location,
      coalesce(w.details -> slot.key ->> 'note', '') as note
    from class_schedule_weeks w
    join classes c on c.id = w.class_id
    cross join lateral jsonb_each_text(w.slots) slot
    where w.class_id = api_homeroom_schedule_sync.class_id
      and (
        (api_homeroom_schedule_sync.record_type = 'LR'
          and slot.value ~ '^(LR|L|R)[0-9]+$')
        or slot.value ~ ('^' || api_homeroom_schedule_sync.record_type || '[0-9]+$')
      )
  ) q;
  return result;
end;
$$;

create or replace function api_attendance_rows(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform require_teacher(api_attendance_rows.teacher_key);

  with raw_schedule as (
    select
      c.id as class_id,
      c.name as class_name,
      case
        when slot.value ~ '^(LR|L|R)[0-9]+$' then 'LR'
        when slot.value ~ '^S[0-9]+$' then 'S'
        when slot.value ~ '^W[0-9]+$' then 'W'
      end as record_type,
      slot.value as lesson_label,
      w.week_start + split_part(slot.key, '-', 1)::integer as lesson_date,
      split_part(slot.key, '-', 2)::integer as session_index,
      coalesce(w.details -> slot.key ->> 'startTime', '') as start_time,
      coalesce(w.details -> slot.key ->> 'teacherName', '') as teacher_name
    from class_schedule_weeks w
    join classes c on c.id = w.class_id and not c.archived
    cross join lateral jsonb_each_text(w.slots) slot
    where slot.value ~ '^(LR|L|R|S|W)[0-9]+$'
      and can_access_class(api_attendance_rows.teacher_key, c.id)
  ),
  schedule_lessons as (
    select rs.*,
      (row_number() over (
        partition by rs.class_id, rs.record_type
        order by rs.lesson_date, rs.session_index, rs.lesson_label
      ) - 1)::integer as lesson_index
    from raw_schedule rs
  ),
  lesson_keys as (
    select h.class_id, h.record_type, g.lesson_index
    from homeroom_records h
    cross join lateral generate_series(0, greatest(0, h.lesson_count - 1)) g(lesson_index)
    where can_access_class(api_attendance_rows.teacher_key, h.class_id)
    union
    select sl.class_id, sl.record_type, sl.lesson_index from schedule_lessons sl
  ),
  expanded as (
    select
      lk.class_id,
      c.name as class_name,
      lk.record_type,
      lk.lesson_index,
      coalesce(nullif(h.cells ->> ('0|' || (3 + lk.lesson_index * 4)::text), ''),
               'B' || (lk.lesson_index + 1)::text) as lesson_title,
      coalesce(nullif(h.cells ->> ('0|' || (4 + lk.lesson_index * 4)::text), ''),
               sl.lesson_label,
               lk.record_type || (lk.lesson_index + 1)::text) as lesson_label,
      coalesce(sl.lesson_date::text,
               nullif(h.cells ->> ('0|' || (5 + lk.lesson_index * 4)::text), ''),
               '') as record_date,
      coalesce(nullif(h.cells ->> ('0|' || (6 + lk.lesson_index * 4)::text), ''),
               sl.teacher_name, '') as record_teacher,
      coalesce(sl.start_time, '') as record_start_time,
      coalesce(counts.student_count, 0) as student_count,
      coalesce(counts.present_count, 0) as present_count,
      coalesce(counts.absent_count, 0) as absent_count,
      coalesce(ae.data, '{}'::jsonb) as entry,
      ae.updated_at,
      coalesce(ta.display_name, '') as updated_by
    from lesson_keys lk
    join classes c on c.id = lk.class_id and not c.archived
    left join homeroom_records h
      on h.class_id = lk.class_id and h.record_type = lk.record_type
    left join schedule_lessons sl
      on sl.class_id = lk.class_id and sl.record_type = lk.record_type
      and sl.lesson_index = lk.lesson_index
    left join lateral (
      select
        count(*)::integer as student_count,
        count(*) filter (where roster.mark in ('TRUE','P','X','CÓ','CÓ MẶT','1'))::integer as present_count,
        count(*) filter (where roster.mark in ('FALSE','V','VẮNG','A','0'))::integer as absent_count
      from (
        select upper(trim(coalesce(
          h.cells ->> (
            ((case when lk.record_type = 'LR' then 2 else 6 end)
             + row_number() over (
               order by lower(s.student_name), s.student_name, s.dob
             ) - 1)::text
            || '|' || (3 + lk.lesson_index * 4)::text
          ), ''
        ))) as mark
        from submissions s
        where s.class_id = lk.class_id and s.status = 'approved'
      ) roster
    ) counts on true
    left join attendance_entries ae
      on ae.class_id = lk.class_id and ae.record_type = lk.record_type
      and ae.lesson_index = lk.lesson_index
    left join teacher_accounts ta on ta.id = ae.updated_by
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'classId', e.class_id,
    'className', e.class_name,
    'recordType', e.record_type,
    'lessonIndex', e.lesson_index,
    'lessonTitle', e.lesson_title,
    'lessonLabel', e.lesson_label,
    'recordDate', e.record_date,
    'recordTeacher', e.record_teacher,
    'recordStartTime', e.record_start_time,
    'studentCount', e.student_count,
    'presentCount', e.present_count,
    'absentCount', e.absent_count,
    'entry', e.entry,
    'updatedAt', e.updated_at,
    'updatedBy', e.updated_by
  ) order by lower(e.class_name), e.class_name,
    case e.record_type when 'LR' then 1 when 'S' then 2 else 3 end,
    e.lesson_index), '[]'::jsonb)
  into result
  from expanded e;
  return result;
end;
$$;

grant execute on function api_schedule_class(text, text, date) to anon;
grant execute on function api_save_schedule_settings(text, text, text, jsonb) to anon;
grant execute on function api_save_schedule_week(text, text, date, text, jsonb, jsonb, text[], text[], jsonb) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_schedule_overview(text, date) to anon;
grant execute on function api_public_schedule(text, text) to anon;
grant execute on function api_homeroom_schedule_sync(text, text, text) to anon;
grant execute on function api_attendance_rows(text) to anon;


-- ============================================================================
-- schedule_v3.sql
-- ============================================================================

-- Olympus schedule v3
-- Run once after schedule_v2.sql. Adds four independently saved lanes per class slot.

create or replace function clean_schedule_lane(value jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'active', lower(coalesce(value ->> 'active', 'false')) = 'true',
    'lesson', case
      when upper(clean_name(value ->> 'lesson')) ~
        '^(S[0-9]*|W[0-9]*|LR[0-9]*|L[0-9]*|R[0-9]*|MT[12]?|FT[12]?|OFF|LESSON|REVIEW)$'
      then upper(clean_name(value ->> 'lesson')) else '' end,
    'lessonType', case
      when upper(clean_name(value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(value ->> 'lessonType')) else '' end,
    'courseNo', case
      when clean_name(value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(value ->> 'courseNo') else '' end,
    'location', left(clean_name(value ->> 'location'), 80),
    'note', left(clean_name(value ->> 'note'), 300),
    'startTime', case
      when clean_name(value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(value ->> 'teacherName'), 120)
  );
$$;

create or replace function api_save_schedule_extra_details(
  teacher_key text,
  class_id text,
  week_start date,
  details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_details jsonb;
begin
  perform require_class_manager(
    api_save_schedule_extra_details.teacher_key,
    api_save_schedule_extra_details.class_id
  );

  select coalesce(jsonb_object_agg(d.key, jsonb_build_object(
    'location', left(clean_name(d.value ->> 'location'), 80),
    'note', left(clean_name(d.value ->> 'note'), 300),
    'startTime', case
      when clean_name(d.value ->> 'startTime') ~ '^[0-2][0-9]:[0-5][0-9]$'
      then clean_name(d.value ->> 'startTime') else '' end,
    'teacherName', left(clean_name(d.value ->> 'teacherName'), 120),
    'courseNo', case
      when clean_name(d.value ->> 'courseNo') ~ '^[0-9]+[ab]?$'
      then clean_name(d.value ->> 'courseNo') else '' end,
    'lessonType', case
      when upper(clean_name(d.value ->> 'lessonType')) ~ '^(LR|L|R|W|S|MT|FT|OFF|LESSON)$'
      then upper(clean_name(d.value ->> 'lessonType')) else '' end,
    'primaryLane', least(3, greatest(0, coalesce(
      case when (d.value ->> 'primaryLane') ~ '^[0-3]$'
        then (d.value ->> 'primaryLane')::integer end,
      0
    ))),
    'lanes', coalesce((
      select jsonb_agg(clean_schedule_lane(lane.value) order by lane.ord)
      from jsonb_array_elements(
        case when jsonb_typeof(d.value -> 'lanes') = 'array'
          then d.value -> 'lanes' else '[]'::jsonb end
      ) with ordinality lane(value, ord)
      where lane.ord <= 4
    ), '[]'::jsonb)
  )), '{}'::jsonb)
  into clean_details
  from jsonb_each(coalesce(api_save_schedule_extra_details.details, '{}'::jsonb)) d
  where d.key ~ '^[0-6]-[0-9]+$';

  update class_schedule_weeks w
  set details = clean_details,
      updated_at = now()
  where w.class_id = api_save_schedule_extra_details.class_id
    and w.week_start = api_save_schedule_extra_details.week_start;
  if not found then raise exception 'Không tìm thấy tuần vừa lưu'; end if;

  update classes c
  set current_schedule_week = api_save_schedule_extra_details.week_start
  where c.id = api_save_schedule_extra_details.class_id;

  return jsonb_build_object('ok', true);
end;
$$;

-- Current-week overview follows the latest yellow cells immediately, even
-- before the owner opens and saves the per-class planner again.
create or replace function api_schedule_overview(
  teacher_key text,
  week_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_monday date := current_date - (extract(isodow from current_date)::integer - 1);
  requested date := coalesce(api_schedule_overview.week_start, current_monday);
  result jsonb;
begin
  perform require_teacher(api_schedule_overview.teacher_key);
  with accessible as (
    select c.*
    from classes c
    where not c.archived
      and can_access_class(api_schedule_overview.teacher_key, c.id)
  ),
  week_directory as (
    select w.week_start, max(w.title) as title
    from class_schedule_weeks w
    join accessible c on c.id = w.class_id
    group by w.week_start
  )
  select jsonb_build_object(
    'weekStart', requested::text,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekStart', wd.week_start::text,
        'title', wd.title
      ) order by wd.week_start desc)
      from week_directory wd
    ), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'sessions', c.sessions,
        'courseKind', c.course_kind,
        'lessonStarts', c.lesson_starts,
        'sectorId', c.sector_id,
        'sectorName', (select cs.name from class_sectors cs where cs.id = c.sector_id),
        'activeSlots', case
          when requested = current_monday then c.current_slots
          else coalesce(w.active_slots, '{}'::text[]) end,
        'slots', case
          when requested = current_monday then coalesce(nullif(w.slots, '{}'::jsonb), c.final_subjects, '{}'::jsonb)
          else coalesce(w.slots, '{}'::jsonb) end,
        'details', case
          when w.id is not null then coalesce(w.details, '{}'::jsonb)
          when requested = current_monday then coalesce((
            select cw.details from class_schedule_weeks cw
            where cw.class_id = c.id
            order by
              case when cw.week_start = c.current_schedule_week then 0 else 1 end,
              cw.week_start desc
            limit 1
          ), '{}'::jsonb)
          else '{}'::jsonb end
      ) order by lower(coalesce((select cs.name from class_sectors cs where cs.id = c.sector_id), '')),
                 lower(c.name), c.name, c.id)
      from accessible c
      left join class_schedule_weeks w
        on w.class_id = c.id and w.week_start = requested
    ), '[]'::jsonb)
  )
  into result;
  return result;
end;
$$;

grant execute on function clean_schedule_lane(jsonb) to anon;
grant execute on function api_save_schedule_extra_details(text, text, date, jsonb) to anon;
grant execute on function api_schedule_overview(text, date) to anon;


-- ============================================================================
-- personalization_v4.sql
-- ============================================================================

-- Olympus personalization v4
-- Run once after schedule_v3.sql. Stores the shared operating profile, presets,
-- symbol palette and locations as one compact JSON document.

insert into app_settings (key, value)
values ('OLYMPUS_PERSONALIZATION', '{}')
on conflict (key) do nothing;

create or replace function api_personalization_profile(teacher_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw_value text;
begin
  perform require_teacher(api_personalization_profile.teacher_key);
  select s.value into raw_value
  from app_settings s
  where s.key = 'OLYMPUS_PERSONALIZATION';

  if coalesce(raw_value, '') = '' then return '{}'::jsonb; end if;
  begin
    return raw_value::jsonb;
  exception when others then
    return '{}'::jsonb;
  end;
end;
$$;

create or replace function api_public_personalization(student_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  full_profile jsonb := '{}'::jsonb;
  raw_value text;
begin
  perform require_student(api_public_personalization.student_key);
  select s.value into raw_value
  from app_settings s
  where s.key = 'OLYMPUS_PERSONALIZATION';
  begin
    full_profile := coalesce(raw_value::jsonb, '{}'::jsonb);
  exception when others then
    full_profile := '{}'::jsonb;
  end;
  return jsonb_build_object(
    'version', 1,
    'centerName', coalesce(full_profile ->> 'centerName', 'Olympus English'),
    'symbols', coalesce(full_profile -> 'symbols', '[]'::jsonb),
    'locations', coalesce(full_profile -> 'locations', '[]'::jsonb)
  );
end;
$$;

create or replace function api_save_personalization_profile(
  teacher_key text,
  profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_profile jsonb := coalesce(api_save_personalization_profile.profile, '{}'::jsonb);
begin
  perform require_owner(api_save_personalization_profile.teacher_key);
  if jsonb_typeof(clean_profile) <> 'object' then
    raise exception 'Cấu hình Olympus phải là một object';
  end if;
  if octet_length(clean_profile::text) > 131072 then
    raise exception 'Cấu hình Olympus vượt quá 128 KB';
  end if;

  insert into app_settings (key, value)
  values ('OLYMPUS_PERSONALIZATION', clean_profile::text)
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('ok', true, 'profile', clean_profile);
end;
$$;

grant execute on function api_personalization_profile(text) to anon;
grant execute on function api_public_personalization(text) to anon;
grant execute on function api_save_personalization_profile(text, jsonb) to anon;


-- ============================================================================
-- schedule_templates_v5.sql
-- ============================================================================

-- Olympus schedule templates and conflict center v5
-- Safe to run repeatedly after personalization_v4.sql.

create table if not exists schedule_templates (
  id uuid primary key default gen_random_uuid(),
  class_id text not null references classes(id) on delete cascade,
  name text not null,
  template_mode text not null default 'structure'
    check (template_mode in ('structure', 'full')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists schedule_templates_class_idx
  on schedule_templates (class_id, lower(name), created_at);

alter table schedule_templates enable row level security;
drop policy if exists "deny direct schedule_templates" on schedule_templates;
create policy "deny direct schedule_templates"
  on schedule_templates for all using (false) with check (false);

create or replace function api_schedule_templates(
  teacher_key text,
  class_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform require_class_manager(
    api_schedule_templates.teacher_key,
    api_schedule_templates.class_id
  );
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'classId', t.class_id,
      'name', t.name,
      'mode', t.template_mode,
      'data', t.data,
      'updatedAt', t.updated_at
    ) order by lower(t.name), t.name, t.created_at, t.id)
    from schedule_templates t
    where t.class_id = api_schedule_templates.class_id
  ), '[]'::jsonb);
end;
$$;

create or replace function api_save_schedule_template(
  teacher_key text,
  class_id text,
  template_id uuid,
  template_name text,
  template_mode text,
  template_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
  clean_name_value text := left(clean_name(api_save_schedule_template.template_name), 100);
  clean_mode text := case
    when lower(coalesce(api_save_schedule_template.template_mode, '')) = 'full' then 'full'
    else 'structure'
  end;
  clean_data jsonb := coalesce(api_save_schedule_template.template_data, '{}'::jsonb);
begin
  perform require_class_manager(
    api_save_schedule_template.teacher_key,
    api_save_schedule_template.class_id
  );
  if clean_name_value = '' then raise exception 'Nhập tên mẫu tuần'; end if;
  if jsonb_typeof(clean_data) <> 'object' then
    raise exception 'Dữ liệu mẫu tuần không hợp lệ';
  end if;
  if octet_length(clean_data::text) > 131072 then
    raise exception 'Mẫu tuần vượt quá 128 KB';
  end if;

  if api_save_schedule_template.template_id is null then
    insert into schedule_templates (class_id, name, template_mode, data)
    values (
      api_save_schedule_template.class_id,
      clean_name_value,
      clean_mode,
      clean_data
    )
    returning id into saved_id;
  else
    update schedule_templates t
    set name = clean_name_value,
        template_mode = clean_mode,
        data = clean_data,
        updated_at = now()
    where t.id = api_save_schedule_template.template_id
      and t.class_id = api_save_schedule_template.class_id
    returning t.id into saved_id;
    if saved_id is null then raise exception 'Không tìm thấy mẫu tuần'; end if;
  end if;

  return jsonb_build_object('ok', true, 'id', saved_id);
end;
$$;

create or replace function api_delete_schedule_template(
  teacher_key text,
  class_id text,
  template_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform require_class_manager(
    api_delete_schedule_template.teacher_key,
    api_delete_schedule_template.class_id
  );
  delete from schedule_templates t
  where t.id = api_delete_schedule_template.template_id
    and t.class_id = api_delete_schedule_template.class_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function api_schedule_templates(text, text) to anon;
grant execute on function api_save_schedule_template(text, text, uuid, text, text, jsonb) to anon;
grant execute on function api_delete_schedule_template(text, text, uuid) to anon;

commit;
